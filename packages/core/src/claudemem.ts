import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from './fsutil.js'

/**
 * Which credentials claude-mem's observer runs on.
 *
 * claude-mem's worker is one process shared by every profile. When it spawns its observer
 * `claude`, it STRIPS ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL and
 * CLAUDE_CONFIG_DIR from the env it inherited, then re-adds credentials from exactly two places:
 *   1. ~/.claude-mem/.env (those same three keys) — wins if present
 *   2. the OAuth token of CLAUDE_MEM_CLAUDE_CONFIG_DIR (default ~/.claude), read from the
 *      keychain under the same per-dir service name Claude Code uses
 * So a user whose only working account is a token/API-key profile gets no credentials at all,
 * and claude-mem silently stops recording. We point it at an OAuth profile when one exists,
 * and otherwise copy a key profile's credentials into a managed block of its .env.
 * (Verified against claude-mem 13.39.0 worker-service.cjs: kGe/Eh/lre.)
 */

export const CLAUDE_MEM_BEGIN = '# >>> ccprofiles managed >>>'
export const CLAUDE_MEM_END = '# <<< ccprofiles managed <<<'
const CRED_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const
// a gateway (z.ai, kimi, ...) rejects claude-mem's default Claude model id; these are where a
// profile declares which model the gateway actually serves for small/fast work
const MODEL_KEYS = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_MODEL'] as const

export interface ClaudeMemCandidate {
  name: string
  dir: string
  /** logged in with OAuth (`oauthAccount` in .claude.json) */
  oauth: boolean
  /** the profile's provider env (settings.json env + launcher env); values may be secret:// refs */
  env: Record<string, string>
}

export type ClaudeMemAuth =
  | { kind: 'oauth'; profile: string; configDir: string }
  | { kind: 'api-key' | 'gateway'; profile: string; env: Record<string, string>; model?: string }

const hasKey = (env: Record<string, string>) => !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)

/**
 * OAuth beats a key; a direct Anthropic key beats a gateway. Within a tier, the profile already in
 * use stays (no churn between runs), then the default ~/.claude, then name order.
 */
export function pickClaudeMemAuth(
  cands: ClaudeMemCandidate[],
  current: { configDir?: string; profile?: string } = {},
): ClaudeMemAuth | null {
  const rank = <T extends ClaudeMemCandidate>(xs: T[], isCurrent: (c: T) => boolean) =>
    xs.find(isCurrent) ?? xs.find(c => c.dir.endsWith('/.claude') || c.dir.endsWith('\\.claude')) ?? xs[0]

  // a profile that sets a key or base URL runs on THAT, not its OAuth login
  const oauth = cands.filter(c => c.oauth && !hasKey(c.env) && !c.env.ANTHROPIC_BASE_URL)
  if (oauth.length) {
    const c = rank(oauth, c => c.dir === current.configDir)
    return { kind: 'oauth', profile: c.name, configDir: c.dir }
  }
  const keyed = cands.filter(c => hasKey(c.env))
  const direct = keyed.filter(c => !c.env.ANTHROPIC_BASE_URL)
  const pool = direct.length ? direct : keyed
  if (!pool.length) return null
  const c = rank(pool, c => c.name === current.profile)
  const env: Record<string, string> = {}
  for (const k of CRED_KEYS) if (c.env[k]) env[k] = c.env[k]
  if (!c.env.ANTHROPIC_BASE_URL) return { kind: 'api-key', profile: c.name, env }
  const model = MODEL_KEYS.map(k => c.env[k]).find(Boolean)
  return { kind: 'gateway', profile: c.name, env, ...(model ? { model } : {}) }
}

export interface ClaudeMemFiles {
  /** parsed ~/.claude-mem/settings.json, or null when absent */
  settings: Record<string, unknown> | null
  /** raw ~/.claude-mem/.env, '' when absent */
  envText: string
}

/** Split .env into the managed block's lines and everything else. */
function splitEnv(text: string): { outside: string[]; block: string[] } {
  const outside: string[] = [], block: string[] = []
  let inBlock = false
  for (const line of text.split('\n')) {
    if (line === CLAUDE_MEM_BEGIN) { inBlock = true; continue }
    if (line === CLAUDE_MEM_END) { inBlock = false; continue }
    ;(inBlock ? block : outside).push(line)
  }
  while (outside.length && outside[outside.length - 1] === '') outside.pop()
  return { outside, block }
}

const blockMeta = (block: string[], key: string) =>
  block.find(l => l.startsWith(`# ${key}=`))?.slice(`# ${key}=`.length)

/** The profile the managed block was last written from — keeps the choice stable across runs. */
export function claudeMemManagedProfile(envText: string): string | undefined {
  return blockMeta(splitEnv(envText).block, 'profile')
}

function envLine(k: string, v: string): string {
  // node's parseEnv (what claude-mem reads with) has its own quoting rules; refusing anything
  // that would need quoting is simpler than matching them, and real tokens/URLs never do
  if (!/^[^\s"'`#\\]+$/.test(v)) throw new Error(`${k} has characters claude-mem's .env cannot hold safely`)
  return `${k}=${v}`
}

/**
 * Desired settings.json + .env for `auth`, or `skip` when the user configured claude-mem by hand
 * (another provider, or their own keys in .env) — those are never overwritten. `auth` env values
 * must already be resolved (no secret:// refs).
 */
export function renderClaudeMemConfig(
  files: ClaudeMemFiles,
  auth: ClaudeMemAuth,
  defaultConfigDir: string,
): { skip: string } | { settings: Record<string, unknown>; envText: string; changes: string[] } {
  const settings: Record<string, unknown> = { ...(files.settings ?? {}) }
  const provider = settings.CLAUDE_MEM_PROVIDER
  if (typeof provider === 'string' && provider && provider !== 'claude')
    return { skip: `claude-mem uses provider "${provider}" — leaving its auth alone` }
  const { outside, block } = splitEnv(files.envText)
  if (outside.some(l => CRED_KEYS.some(k => l.trimStart().replace(/^export\s+/, '').startsWith(`${k}=`))))
    return { skip: 'claude-mem has its own credentials in ~/.claude-mem/.env — leaving them alone' }

  const changes: string[] = []
  const set = (k: string, v: string) => {
    if ((settings[k] ?? '') !== v) { settings[k] = v; changes.push(`${k}=${v || '(default)'}`) }
  }
  const prevModel = blockMeta(block, 'model-before')
  let newBlock: string[] = []

  if (auth.kind === 'oauth') {
    set('CLAUDE_MEM_CLAUDE_AUTH_METHOD', 'subscription')
    // '' means ~/.claude — claude-mem treats the default dir as non-explicit either way
    set('CLAUDE_MEM_CLAUDE_CONFIG_DIR', auth.configDir === defaultConfigDir ? '' : auth.configDir)
    if (prevModel !== undefined) set('CLAUDE_MEM_MODEL', prevModel)
  } else {
    set('CLAUDE_MEM_CLAUDE_AUTH_METHOD', auth.kind)
    set('CLAUDE_MEM_CLAUDE_CONFIG_DIR', '')
    newBlock.push(`# profile=${auth.profile}`)
    if (auth.kind === 'gateway' && auth.model) {
      // remember the model we replaced, once, so switching back to Anthropic restores it
      const before = prevModel ?? (typeof settings.CLAUDE_MEM_MODEL === 'string' ? settings.CLAUDE_MEM_MODEL : '')
      newBlock.push(`# model-before=${before}`)
      set('CLAUDE_MEM_MODEL', auth.model)
    } else if (prevModel !== undefined) set('CLAUDE_MEM_MODEL', prevModel)
    for (const [k, v] of Object.entries(auth.env)) newBlock.push(envLine(k, v))
  }

  const blockChanged = newBlock.join('\n') !== block.join('\n')
  if (blockChanged) changes.push(newBlock.length ? `.env credentials from profile "${auth.profile}"` : '.env credentials removed')
  const envText = newBlock.length
    ? [...outside, ...(outside.length ? [''] : []), CLAUDE_MEM_BEGIN, ...newBlock, CLAUDE_MEM_END, ''].join('\n')
    : outside.length ? outside.join('\n') + '\n' : ''
  return { settings, envText, changes }
}

/** Read claude-mem's config. A corrupt settings.json throws — rewriting it would wipe every other key. */
export async function readClaudeMemFiles(dataDir: string): Promise<ClaudeMemFiles> {
  let settings: Record<string, unknown> | null = null
  try { settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) }
  catch (e: any) {
    if (e?.code !== 'ENOENT') throw new Error(`cannot read ${join(dataDir, 'settings.json')}: ${e.message} — fix or remove it`)
  }
  let envText = ''
  try { envText = await readFile(join(dataDir, '.env'), 'utf8') }
  catch (e: any) { if (e?.code !== 'ENOENT') throw e }
  return { settings, envText }
}

export async function writeClaudeMemFiles(dataDir: string, before: ClaudeMemFiles, after: { settings: Record<string, unknown>; envText: string }): Promise<void> {
  const settingsPath = join(dataDir, 'settings.json')
  if (JSON.stringify(after.settings) !== JSON.stringify(before.settings ?? {})) {
    let mode = 0o600
    try { mode = (await stat(settingsPath)).mode & 0o777 } catch { /* new file */ }
    await atomicWrite(settingsPath, JSON.stringify(after.settings, null, 2) + '\n', { mode })
  }
  // .env holds a live API key — always owner-only
  if (after.envText !== before.envText) await atomicWrite(join(dataDir, '.env'), after.envText, { mode: 0o600 })
}
