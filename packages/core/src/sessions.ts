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
  scope: string   // 'shared' or a profile name
  project: string // real cwd from the transcript, else best-effort decoded dir name
  sessions: SessionMeta[]
}

/** Best-effort decode of Claude Code's project dir name (cwd from a record is preferred). */
export function decodeProjectDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/')
}

async function parseSession(file: string): Promise<{ meta: SessionMeta; cwd: string | null } | null> {
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
      const parsed = await parseSession(join(pdir, f))
      if (!parsed) continue
      sessions.push(parsed.meta)
      if (cwd === null) cwd = parsed.cwd
    }
    if (!sessions.length) continue
    sessions.sort((a, b) => b.mtime - a.mtime)
    out.push({ scope, project: cwd ?? decodeProjectDir(proj.name), sessions })
  }
  return out
}

export async function scanSessions(opts: {
  sharedRoot: string
  profiles: { name: string; dir: string }[]
}): Promise<ProjectSessions[]> {
  const out: ProjectSessions[] = []
  out.push(...await scanProjectsDir(join(opts.sharedRoot, 'projects'), 'shared'))
  for (const p of opts.profiles) {
    const projectsDir = join(p.dir, 'projects')
    try { if ((await lstat(projectsDir)).isSymbolicLink()) continue } catch { continue }
    out.push(...await scanProjectsDir(projectsDir, p.name))
  }
  return out
}
