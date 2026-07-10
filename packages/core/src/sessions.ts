import { readdir, readFile, stat, lstat } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export interface SessionMeta {
  id: string
  mtime: number
  messageCount: number
  firstPrompt: string | null
  gitBranch: string | null
  model: string | null
  sizeBytes: number
}

export interface ProjectSessions {
  agent: 'claude' | 'codex'
  scope: string   // 'shared' or a profile name
  project: string // real cwd from the transcript, else best-effort decoded dir name
  sessions: SessionMeta[]
}

/** Best-effort decode of Claude Code's project dir name (cwd from a record is preferred). */
export function decodeProjectDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/')
}

async function parseClaudeSession(file: string): Promise<{ meta: SessionMeta; cwd: string | null } | null> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const st = await stat(file)
  const lines = raw.split('\n').filter(l => l.trim())
  let firstPrompt: string | null = null, gitBranch: string | null = null, model: string | null = null, cwd: string | null = null
  for (const line of lines) {
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd
    if (gitBranch === null && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch
    if (firstPrompt === null && rec.type === 'user') {
      const c = rec.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x?.type === 'text')?.text : null
      if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) firstPrompt = text.trim().slice(0, 200)
    }
    if (model === null && typeof rec.message?.model === 'string') model = rec.message.model
    if (firstPrompt && model && gitBranch && cwd) break
  }
  const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  return { meta: { id, mtime: st.mtimeMs, messageCount: lines.length, firstPrompt, gitBranch, model, sizeBytes: st.size }, cwd }
}

async function scanProjectsDir(projectsDir: string, scope: string): Promise<ProjectSessions[]> {
  if (!existsSync(projectsDir)) return []
  const out: ProjectSessions[] = []
  let entries: Dirent[]
  try { entries = await readdir(projectsDir, { withFileTypes: true }) } catch { return [] }
  for (const proj of entries) {
    if (!proj.isDirectory()) continue
    const pdir = join(projectsDir, proj.name)
    const sessions: SessionMeta[] = []
    let cwd: string | null = null
    let files: string[]
    try { files = await readdir(pdir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const parsed = await parseClaudeSession(join(pdir, f))
      if (!parsed) continue
      sessions.push(parsed.meta)
      if (cwd === null) cwd = parsed.cwd
    }
    if (!sessions.length) continue
    sessions.sort((a, b) => b.mtime - a.mtime)
    out.push({ agent: 'claude', scope, project: cwd ?? decodeProjectDir(proj.name), sessions })
  }
  return out
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const item = content.find((x: any) => x?.type === 'input_text' || x?.type === 'text')
  return typeof item?.text === 'string' ? item.text : null
}

async function parseCodexSession(file: string): Promise<{ meta: SessionMeta; cwd: string | null } | null> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const st = await stat(file)
  const lines = raw.split('\n').filter(l => l.trim())
  let id: string | null = null, firstPrompt: string | null = null, gitBranch: string | null = null
  let model: string | null = null, cwd: string | null = null, messageCount = 0
  for (const line of lines) {
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    const payload = rec?.payload
    if (rec?.type === 'session_meta') {
      if (typeof payload?.id === 'string') id = payload.id
      else if (typeof payload?.session_id === 'string') id = payload.session_id
      if (typeof payload?.cwd === 'string') cwd = payload.cwd
      if (typeof payload?.git?.branch === 'string') gitBranch = payload.git.branch
    }
    if (rec?.type === 'turn_context') {
      if (cwd === null && typeof payload?.cwd === 'string') cwd = payload.cwd
      if (model === null && typeof payload?.model === 'string') model = payload.model
    }
    if (rec?.type === 'response_item' && payload?.type === 'message'
      && (payload?.role === 'user' || payload?.role === 'assistant')) {
      messageCount++
      if (firstPrompt === null && payload.role === 'user') {
        const text = messageText(payload.content)
        if (text?.trim() && !text.trimStart().startsWith('<')) firstPrompt = text.trim().slice(0, 200)
      }
    }
    if (firstPrompt === null && rec?.type === 'event_msg' && payload?.type === 'user_message'
      && typeof payload?.message === 'string' && payload.message.trim()) {
      firstPrompt = payload.message.trim().slice(0, 200)
    }
  }
  const filename = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  id ??= filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? filename
  return { meta: { id, mtime: st.mtimeMs, messageCount: messageCount || lines.length, firstPrompt, gitBranch, model, sizeBytes: st.size }, cwd }
}

async function codexSessionFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await codexSessionFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

async function scanCodexSessionsDir(sessionsDir: string, scope: string): Promise<ProjectSessions[]> {
  const byProject = new Map<string, SessionMeta[]>()
  for (const file of await codexSessionFiles(sessionsDir)) {
    const parsed = await parseCodexSession(file)
    if (!parsed) continue
    const project = parsed.cwd ?? '(unknown project)'
    const sessions = byProject.get(project) ?? []
    sessions.push(parsed.meta)
    byProject.set(project, sessions)
  }
  return [...byProject.entries()].map(([project, sessions]) => ({
    agent: 'codex' as const, scope, project,
    sessions: sessions.sort((a, b) => b.mtime - a.mtime),
  }))
}

export async function scanSessions(opts: {
  sharedRoot: string
  profiles: { name: string; dir: string; agent?: 'claude' | 'codex' }[]
}): Promise<ProjectSessions[]> {
  const out: ProjectSessions[] = []
  out.push(...await scanProjectsDir(join(opts.sharedRoot, 'projects'), 'shared'))
  out.push(...await scanCodexSessionsDir(join(opts.sharedRoot, 'sessions'), 'shared'))
  for (const p of opts.profiles) {
    const agent = p.agent ?? 'claude'
    const sessionDir = join(p.dir, agent === 'codex' ? 'sessions' : 'projects')
    try { if ((await lstat(sessionDir)).isSymbolicLink()) continue } catch { continue }
    out.push(...agent === 'codex'
      ? await scanCodexSessionsDir(sessionDir, p.name)
      : await scanProjectsDir(sessionDir, p.name))
  }
  return out
}
