import { readdir, readFile, stat, lstat, open, type FileHandle } from 'node:fs/promises'
import { existsSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'

export interface SessionMeta {
  id: string
  mtime: number
  /** Timestamp (ms) of the last user/assistant record — when you last chatted, not when the
   *  file was created or last copied. Falls back to mtime when no record carries a timestamp. */
  lastActivity: number
  messageCount: number
  /** Session name: your `/rename` title if set, else Claude's auto-generated one. */
  title?: string | null
  firstPrompt: string | null
  gitBranch: string | null
  model: string | null
  sizeBytes: number
  /** true when the transcript was too large to fully scan (per-file cap) or the per-request
   *  byte budget ran out before reaching it — metadata is best-effort / incomplete. */
  truncated?: boolean
  /** Driven by the Agent SDK (e.g. a plugin's background worker), not a chat you'd resume. */
  automated?: boolean
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
// enough to reach the first real prompt (Codex Desktop front-loads ~140KB of AGENTS.md and
// instructions), without reading a multi-MB transcript
const HEAD_SCAN_BYTES = 256 * 1024
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

/**
 * Last resort only — lossy, and unfixably so. Claude Code encodes a project path by replacing
 * every '/' with '-', so a segment that legitimately contains a hyphen (`/Users/lp-stf00543`)
 * cannot be told apart from a separator on the way back. Prefer the `cwd` recorded inside the
 * session file; `headCwd` exists so that stays available even for files we decline to read.
 */
export function decodeProjectDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/')
}

/** First (or, with `fromEnd`, last) `bytes` of a file, for cheap field recovery without
 *  reading a multi-MB transcript. */
async function readHead(file: string, bytes = HEAD_SCAN_BYTES, fromEnd = false): Promise<string> {
  let fh: FileHandle | null = null
  try {
    fh = await open(file, 'r')
    const buf = Buffer.alloc(bytes)
    const pos = fromEnd ? Math.max(0, (await fh.stat()).size - bytes) : 0
    const { bytesRead } = await fh.read(buf, 0, bytes, pos)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * First cwd found in a head slice. A slice cut mid-record leaves a partial trailing line, which
 * simply fails JSON.parse and is skipped — no need to guess which line is incomplete.
 */
export function headCwd(head: string, pick: (rec: any) => string | undefined): string | null {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    const v = pick(rec)
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** Is this record a chat turn (user or assistant), in either the Claude or Codex format? */
function isChatRecord(rec: any): boolean {
  if (rec?.type === 'user' || rec?.type === 'assistant') return true
  const p = rec?.payload
  if (rec?.type === 'response_item') return p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')
  return rec?.type === 'event_msg' && (p?.type === 'user_message' || p?.type === 'agent_message')
}

/**
 * Latest chat-record timestamp in a JSONL slice, or null. Partial lines at either edge of a
 * slice fail JSON.parse and are skipped.
 */
export function lastChatTime(text: string): number | null {
  let last: number | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (!isChatRecord(rec) || typeof rec.timestamp !== 'string') continue
    const t = Date.parse(rec.timestamp)
    if (!Number.isNaN(t) && (last === null || t > last)) last = t
  }
  return last
}

/** Latest custom title in a Claude JSONL slice, else the latest AI-generated one, else null. */
export function sessionTitle(text: string): string | null {
  let custom: string | null = null, ai: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) custom = rec.customTitle.trim()
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) ai = rec.aiTitle.trim()
  }
  return custom ?? ai
}

/**
 * Shared mtime+size cache lookup for the two session-file formats. `parseFull` runs only on a
 * cache miss with a fresh read. When the file is over the per-file cap or the per-request byte
 * budget is exhausted, `parseFull` runs on just the head slice (prompt, cwd, branch, model all
 * live near the top) and the last chat time comes from the tail slice. A size-cap truncation is
 * deterministic (depends only on the file) and gets cached; a budget-cap truncation depends on
 * request ordering, so it is *not* cached — a later request with a fresh budget may read it fully.
 */
async function cachedParse(
  file: string,
  cache: Map<string, CacheEntry>,
  budget: ScanBudget,
  parseFull: (raw: string, st: Stats) => ParsedSession,
): Promise<ParsedSession | null> {
  const truncated = async (): Promise<ParsedSession> => {
    const r = parseFull(await readHead(file), st)
    const tail = await readHead(file, HEAD_SCAN_BYTES, true)
    // a single record can outgrow the head slice, so look for the SDK marker in the tail too
    const automated = r.meta.automated || /"entrypoint":"sdk/.test(tail)
    const title = sessionTitle(tail) ?? r.meta.title
    return { ...r, meta: { ...r.meta, ...(title && { title }), messageCount: 0, lastActivity: lastChatTime(tail) ?? st.mtimeMs, truncated: true, ...(automated && { automated }) } }
  }
  let st: Stats
  try { st = await stat(file) } catch { return null }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    scanCacheHits++
    return cached.result
  }
  scanCacheMisses++
  if (st.size > MAX_FILE_SCAN_BYTES) {
    const result = await truncated()
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result })
    return result
  }
  if (st.size > budget.bytesLeft) return truncated() // not cached — budget is per-request
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
      let automated = false
      for (const line of lines) {
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (typeof rec.entrypoint === 'string' && rec.entrypoint.startsWith('sdk')) automated = true
        if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd
        if (gitBranch === null && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch
        if (firstPrompt === null && rec.type === 'user') {
          const c = rec.message?.content
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x?.type === 'text' && !String(x.text).trimStart().startsWith('<'))?.text : null
          if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) firstPrompt = text.trim().slice(0, 200)
        }
        if (model === null && typeof rec.message?.model === 'string') model = rec.message.model
        if (firstPrompt && model && gitBranch && cwd) break
      }
      const lastActivity = lastChatTime(raw) ?? st.mtimeMs
      return { meta: { id, mtime: st.mtimeMs, lastActivity, messageCount: lines.length, title: sessionTitle(raw), firstPrompt, gitBranch, model, sizeBytes: st.size, ...(automated && { automated }) }, cwd }
    },
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
    sessions.sort((a, b) => b.lastActivity - a.lastActivity)
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
  let seenMeta = false
  for (const rec of records) {
    const payload = rec?.payload
    if (rec?.type === 'session_meta') {
      // a sub-agent thread replays its parent's session_meta after its own — the first is ours
      if (seenMeta) continue
      seenMeta = true
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
      let seenMeta = false, automated = false
      for (const line of lines) {
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        const payload = rec?.payload
        // a sub-agent thread replays its parent's session_meta after its own — the first is ours
        if (rec?.type === 'session_meta' && !seenMeta) {
          seenMeta = true
          automated = payload?.thread_source === 'subagent' || payload?.source?.subagent !== undefined
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
            if (text?.trim() && !/^\s*(<|# AGENTS\.md instructions)/.test(text)) firstPrompt = text.trim().slice(0, 200)
          }
        }
        if (firstPrompt === null && rec?.type === 'event_msg' && payload?.type === 'user_message'
          && typeof payload?.message === 'string' && payload.message.trim()) {
          firstPrompt = payload.message.trim().slice(0, 200)
        }
      }
      id ??= fallbackId
      return { meta: { id, mtime: st.mtimeMs, lastActivity: lastChatTime(raw) ?? st.mtimeMs, messageCount: messageCount || lines.length, firstPrompt, gitBranch, model, sizeBytes: st.size, ...(automated && { automated }) }, cwd }
    },
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
    sessions: sessions.sort((a, b) => b.lastActivity - a.lastActivity),
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
  return out.sort((a, b) => b.sessions[0].lastActivity - a.sessions[0].lastActivity)
}

export interface RecentSession {
  agent: 'claude' | 'codex'
  scope: string
  project: string
  session: SessionMeta
}

/** The `limit` sessions you chatted in most recently, across every project and profile. */
export function recentSessions(rows: ProjectSessions[], limit = 10): RecentSession[] {
  return rows
    .flatMap(p => p.sessions.filter(s => !s.automated).map(session => ({ agent: p.agent, scope: p.scope, project: p.project, session })))
    .sort((a, b) => b.session.lastActivity - a.session.lastActivity)
    .slice(0, limit)
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Paste-ready command that reopens a session in its own project under the profile that owns it.
 * Prefers the profile's launcher (it carries provider env and secrets); otherwise points the
 * agent at the profile dir directly. `owner` is null when no declared profile matches the scope.
 */
export function resumeCommand(
  r: Pick<RecentSession, 'agent' | 'project' | 'session'>,
  owner: { launcher: string | null; dir: string } | null,
): string {
  const resume = r.agent === 'codex' ? `resume ${r.session.id}` : `--resume ${r.session.id}`
  const bin = r.agent === 'codex' ? 'codex' : 'claude'
  const run = owner?.launcher ? `${owner.launcher} ${resume}`
    : owner ? `${r.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}=${shq(owner.dir)} ${bin} ${resume}`
    : `${bin} ${resume}`
  return r.project.startsWith('/') ? `cd ${shq(r.project)} && ${run}` : run
}

/**
 * Which profile reopens a session: the one named by its scope, or — for the shared pool — the
 * first profile of the same agent that shares sessions.
 */
export function sessionOwner<P extends { name: string; agent?: 'claude' | 'codex'; sharedSessions?: boolean }>(
  r: Pick<RecentSession, 'agent' | 'scope'>, profiles: P[],
): P | null {
  const same = profiles.filter(p => (p.agent ?? 'claude') === r.agent)
  return (r.scope === 'shared' ? same.find(p => p.sharedSessions) : same.find(p => p.name === r.scope)) ?? null
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
