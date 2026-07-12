import { readdir, readFile, stat, lstat } from 'node:fs/promises'
import { existsSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'

export interface SessionMeta {
  id: string
  mtime: number
  messageCount: number
  firstPrompt: string | null
  gitBranch: string | null
  model: string | null
  sizeBytes: number
  /** true when the transcript was too large to fully scan (per-file cap) or the per-request
   *  byte budget ran out before reaching it — metadata is best-effort / incomplete. */
  truncated?: boolean
}

export interface ProjectSessions {
  agent: 'claude' | 'codex'
  scope: string   // 'shared' or a profile name
  project: string // real cwd from the transcript, else best-effort decoded dir name
  sessions: SessionMeta[]
}

export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  label: string | null
  timestamp: string | null
}

export interface SessionTranscript {
  id: string
  agent: 'claude' | 'codex'
  scope: string
  project: string
  messages: TranscriptEntry[]
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/
const MAX_ENTRY_CHARS = 100_000

// ── session-scan cache ────────────────────────────────────────────────────────
// GET /api/sessions rescans every profile's session directory on every request. Full-file
// re-parsing on each hit is wasteful once histories grow, so cache the parsed metadata per file
// keyed by (mtimeMs, size): unchanged files are served from cache, changed files are re-parsed.
// Kept as a simple module-level Map — good enough for a single long-lived CLI process.
type ParsedSession = { meta: SessionMeta; cwd: string | null }
interface CacheEntry { mtimeMs: number; size: number; result: ParsedSession | null }
const claudeSessionCache = new Map<string, CacheEntry>()
const codexSessionCache = new Map<string, CacheEntry>()

/** Per-file cap: a transcript above this size is summarized without reading its content. */
const MAX_FILE_SCAN_BYTES = 10 * 1024 * 1024
/** Per-request cap: once this many bytes have been read from disk in one scanSessions() call,
 *  remaining (uncached) files are summarized without reading their content either. */
const MAX_TOTAL_SCAN_BYTES = 50 * 1024 * 1024

interface ScanBudget { bytesLeft: number }

let scanCacheHits = 0
let scanCacheMisses = 0
/** Test/observability hook: cumulative cache hit/miss counts across all scanSessions() calls
 *  in this process. Not reset automatically — callers that need deltas should diff two reads. */
export function sessionScanCacheStats(): { hits: number; misses: number } {
  return { hits: scanCacheHits, misses: scanCacheMisses }
}

/** Best-effort decode of Claude Code's project dir name (cwd from a record is preferred). */
export function decodeProjectDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/')
}

/**
 * Shared mtime+size cache lookup for the two session-file formats. `parseFull` runs only on a
 * cache miss with a fresh read; `makeTruncated` builds a summary-only result when the file is
 * over the per-file cap or the per-request byte budget is exhausted. A size-cap truncation is
 * deterministic (depends only on the file) and gets cached; a budget-cap truncation depends on
 * request ordering, so it is *not* cached — a later request with a fresh budget may read it fully.
 */
async function cachedParse(
  file: string,
  cache: Map<string, CacheEntry>,
  budget: ScanBudget,
  parseFull: (raw: string, st: Stats) => ParsedSession,
  makeTruncated: (st: Stats) => ParsedSession,
): Promise<ParsedSession | null> {
  let st: Stats
  try { st = await stat(file) } catch { return null }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    scanCacheHits++
    return cached.result
  }
  scanCacheMisses++
  if (st.size > MAX_FILE_SCAN_BYTES) {
    const result = makeTruncated(st)
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result })
    return result
  }
  if (st.size > budget.bytesLeft) return makeTruncated(st) // not cached — budget is per-request
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { return null }
  budget.bytesLeft -= st.size
  const result = parseFull(raw, st)
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result })
  return result
}

async function parseClaudeSession(file: string, budget: ScanBudget): Promise<ParsedSession | null> {
  const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  return cachedParse(file, claudeSessionCache, budget,
    (raw, st) => {
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
      return { meta: { id, mtime: st.mtimeMs, messageCount: lines.length, firstPrompt, gitBranch, model, sizeBytes: st.size }, cwd }
    },
    st => ({ meta: { id, mtime: st.mtimeMs, messageCount: 0, firstPrompt: null, gitBranch: null, model: null, sizeBytes: st.size, truncated: true }, cwd: null }),
  )
}

async function scanProjectsDir(projectsDir: string, scope: string, budget: ScanBudget): Promise<ProjectSessions[]> {
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
      const parsed = await parseClaudeSession(join(pdir, f), budget)
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
  const texts = content
    .filter((x: any) => x?.type === 'input_text' || x?.type === 'output_text' || x?.type === 'text')
    .map((x: any) => x.text)
    .filter((x: unknown): x is string => typeof x === 'string')
  return texts.length ? texts.join('\n\n') : null
}

function limited(text: string): string {
  return text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}\n\n[entry truncated for display]`
}

function toolText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function pushEntry(
  messages: TranscriptEntry[],
  role: TranscriptEntry['role'],
  text: string | null,
  label: string | null,
  timestamp: unknown,
): void {
  const clean = text?.trim()
  if (!clean) return
  if (role === 'user' && /^<(system-reminder|local-command-caveat|command-name)>/i.test(clean)) return
  const previous = messages.at(-1)
  if (previous?.role === role && previous.text === clean) return
  messages.push({
    id: String(messages.length + 1), role, text: limited(clean), label,
    timestamp: typeof timestamp === 'string' ? timestamp : null,
  })
}

async function parseClaudeTranscript(file: string, scope: string): Promise<SessionTranscript | null> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  const messages: TranscriptEntry[] = []
  let project = '(unknown project)'
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (project === '(unknown project)' && typeof rec.cwd === 'string') project = rec.cwd
    const content = rec.message?.content
    if (rec.type === 'user') {
      pushEntry(messages, 'user', messageText(content), null, rec.timestamp)
      if (Array.isArray(content)) for (const block of content) {
        if (block?.type === 'tool_result')
          pushEntry(messages, 'tool', messageText(block.content) ?? toolText(block.content), 'Tool result', rec.timestamp)
      }
    } else if (rec.type === 'assistant') {
      pushEntry(messages, 'assistant', messageText(content), null, rec.timestamp)
      if (Array.isArray(content)) for (const block of content) {
        if (block?.type === 'tool_use')
          pushEntry(messages, 'tool', toolText(block.input), typeof block.name === 'string' ? block.name : 'Tool call', rec.timestamp)
      }
    }
  }
  return { id, agent: 'claude', scope, project, messages }
}

async function parseCodexTranscript(file: string, scope: string): Promise<SessionTranscript | null> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const records: any[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* malformed line */ }
  }
  const filename = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  let id = filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? filename
  let project = '(unknown project)'
  const hasResponseMessages = records.some(rec => rec?.type === 'response_item' && rec?.payload?.type === 'message')
  const messages: TranscriptEntry[] = []
  for (const rec of records) {
    const payload = rec?.payload
    if (rec?.type === 'session_meta') {
      if (typeof payload?.id === 'string') id = payload.id
      else if (typeof payload?.session_id === 'string') id = payload.session_id
      if (typeof payload?.cwd === 'string') project = payload.cwd
      continue
    }
    if (project === '(unknown project)' && rec?.type === 'turn_context' && typeof payload?.cwd === 'string') project = payload.cwd
    if (rec?.type === 'response_item') {
      if (payload?.type === 'message' && (payload.role === 'user' || payload.role === 'assistant'))
        pushEntry(messages, payload.role, messageText(payload.content), null, rec.timestamp)
      else if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call' || payload?.type === 'local_shell_call')
        pushEntry(messages, 'tool', toolText(payload.arguments ?? payload.input ?? payload), payload.name ?? payload.type, rec.timestamp)
      else if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')
        pushEntry(messages, 'tool', toolText(payload.output), 'Tool result', rec.timestamp)
    } else if (!hasResponseMessages && rec?.type === 'event_msg') {
      if (payload?.type === 'user_message') pushEntry(messages, 'user', payload.message, null, rec.timestamp)
      else if (payload?.type === 'agent_message') pushEntry(messages, 'assistant', payload.message, null, rec.timestamp)
    }
  }
  return { id, agent: 'codex', scope, project, messages }
}

async function parseCodexSession(file: string, budget: ScanBudget): Promise<ParsedSession | null> {
  const filename = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  const fallbackId = filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? filename
  return cachedParse(file, codexSessionCache, budget,
    (raw, st) => {
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
      id ??= fallbackId
      return { meta: { id, mtime: st.mtimeMs, messageCount: messageCount || lines.length, firstPrompt, gitBranch, model, sizeBytes: st.size }, cwd }
    },
    st => ({ meta: { id: fallbackId, mtime: st.mtimeMs, messageCount: 0, firstPrompt: null, gitBranch: null, model: null, sizeBytes: st.size, truncated: true }, cwd: null }),
  )
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

async function claudeSessionFile(projectsDir: string, id: string): Promise<string | null> {
  let projects: Dirent[]
  try { projects = await readdir(projectsDir, { withFileTypes: true }) } catch { return null }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const file = join(projectsDir, project.name, `${id}.jsonl`)
    try { if ((await stat(file)).isFile()) return file } catch { /* keep looking */ }
  }
  return null
}

async function scanCodexSessionsDir(sessionsDir: string, scope: string, budget: ScanBudget): Promise<ProjectSessions[]> {
  const byProject = new Map<string, SessionMeta[]>()
  for (const file of await codexSessionFiles(sessionsDir)) {
    const parsed = await parseCodexSession(file, budget)
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
  const budget: ScanBudget = { bytesLeft: MAX_TOTAL_SCAN_BYTES }
  const out: ProjectSessions[] = []
  out.push(...await scanProjectsDir(join(opts.sharedRoot, 'projects'), 'shared', budget))
  out.push(...await scanCodexSessionsDir(join(opts.sharedRoot, 'sessions'), 'shared', budget))
  for (const p of opts.profiles) {
    const agent = p.agent ?? 'claude'
    const sessionDir = join(p.dir, agent === 'codex' ? 'sessions' : 'projects')
    try { if ((await lstat(sessionDir)).isSymbolicLink()) continue } catch { continue }
    out.push(...agent === 'codex'
      ? await scanCodexSessionsDir(sessionDir, p.name, budget)
      : await scanProjectsDir(sessionDir, p.name, budget))
  }
  return out
}

/** Read visible conversation and tool activity for one known managed session. */
export async function readSessionTranscript(opts: {
  sharedRoot: string
  profiles: { name: string; dir: string; agent?: 'claude' | 'codex' }[]
  agent: 'claude' | 'codex'
  scope: string
  id: string
}): Promise<SessionTranscript | null> {
  if (!SAFE_SESSION_ID.test(opts.id)) return null
  let root: string
  if (opts.scope === 'shared') root = join(opts.sharedRoot, opts.agent === 'codex' ? 'sessions' : 'projects')
  else {
    const profile = opts.profiles.find(p => p.name === opts.scope && (p.agent ?? 'claude') === opts.agent)
    if (!profile) return null
    root = join(profile.dir, opts.agent === 'codex' ? 'sessions' : 'projects')
    try { if ((await lstat(root)).isSymbolicLink()) return null } catch { return null }
  }
  if (opts.agent === 'claude') {
    const file = await claudeSessionFile(root, opts.id)
    return file ? parseClaudeTranscript(file, opts.scope) : null
  }
  const files = await codexSessionFiles(root)
  files.sort((a, b) => Number(!a.includes(opts.id)) - Number(!b.includes(opts.id)))
  for (const file of files) {
    const transcript = await parseCodexTranscript(file, opts.scope)
    if (transcript?.id === opts.id) return transcript
  }
  return null
}
