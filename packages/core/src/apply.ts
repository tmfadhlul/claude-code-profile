import { cp, lstat, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Manifest, McpServerDef } from './manifest.js'
import type { LiveProfile } from './discovery.js'
import { renderPath, type Platform } from './platform.js'
import { renderRcBlock, upsertManagedBlock } from './rcblock.js'
import { atomicWrite, backupFiles, backupTree } from './fsutil.js'
import { writeCodexMcpServers } from './codex.js'

export type ApplyAction =
  | { kind: 'set-mcp-servers'; agent: 'claude' | 'codex'; configPath: string; servers: Record<string, McpServerDef> }
  | { kind: 'create-profile-dir'; dir: string }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'rc-block'; rcFile: string; block: string }
  | { kind: 'set-settings-env'; settingsPath: string; env: Record<string, string> }
  | { kind: 'share-session-dir'; from: string; to: string }
  | { kind: 'unshare-session-dir'; from: string; to: string }

function configPathFor(dir: string, home: string, agent: 'claude' | 'codex'): string {
  if (agent === 'codex') return join(dir, 'config.toml')
  return dir === join(home, '.claude') ? join(home, '.claude.json') : join(dir, '.claude.json')
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

const SECRET_PREFIX = 'secret://'
const CLAUDE_SHARED_ENTRIES = ['projects', 'todos', 'shell-snapshots'] as const

/** Resolve secret:// refs in every profile's settingsEnv. Throws on a missing secret. */
export async function resolveSettingsEnv(
  m: Manifest,
  getSecret: (name: string) => Promise<string | null>,
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  for (const pr of m.profiles) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(pr.settingsEnv ?? {})) {
      if (v.startsWith(SECRET_PREFIX)) {
        const ref = v.slice(SECRET_PREFIX.length)
        const val = await getSecret(ref)
        if (val === null) throw new Error(`profile "${pr.name}": secret not found: ${ref} (for ${k})`)
        env[k] = val
      } else env[k] = v
    }
    out[pr.name] = env
  }
  return out
}

export function planApply(m: Manifest, live: LiveProfile[], p: Platform, resolvedSettingsEnv?: Record<string, Record<string, string>>, sharedRoot: string = join(p.home, '.ccprofiles', 'shared')): ApplyAction[] {
  const actions: ApplyAction[] = []
  const hubProfile = m.profiles.find(x => x.name === m.hub) ?? null

  for (const pr of m.profiles) {
    const agent = pr.agent ?? 'claude'
    const dir = renderPath(pr.dir, p)
    const lp = live.find(l => l.dir === dir) ?? null
    const desired: Record<string, McpServerDef> = {}
    for (const name of pr.mcp) desired[name] = m.mcpServers[name]

    if (!lp) actions.push({ kind: 'create-profile-dir', dir })

    const current = lp?.mcpServers ?? null
    if (!current || JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(desired))) {
      actions.push({ kind: 'set-mcp-servers', agent, configPath: configPathFor(dir, p.home, agent), servers: desired })
    }

    for (const [entry, target] of Object.entries(pr.links)) {
      const to = target === 'hub' && hubProfile
        ? join(renderPath(hubProfile.dir, p), entry)
        : renderPath(target, p)
      const from = join(dir, entry)
      if (lp?.links[entry] === to) continue
      actions.push({ kind: 'link', from, to })
    }

    const sharedEntries: readonly string[] = agent === 'codex' ? ['sessions'] : CLAUDE_SHARED_ENTRIES
    for (const entry of sharedEntries) {
      const from = join(dir, entry)
      const to = join(sharedRoot, entry)
      const linkedToPool = lp?.links[entry] === to
      if (pr.sharedSessions && !linkedToPool) actions.push({ kind: 'share-session-dir', from, to })
      else if (!pr.sharedSessions && linkedToPool) actions.push({ kind: 'unshare-session-dir', from, to })
    }

    const senv = pr.settingsEnv ?? {} // literals in older tests may omit the field
    if (agent === 'claude' && Object.keys(senv).length > 0) {
      let desired = resolvedSettingsEnv?.[pr.name]
      if (!desired) {
        if (Object.values(senv).some(v => v.startsWith(SECRET_PREFIX)))
          throw new Error(`profile "${pr.name}": settingsEnv has secret refs — pass resolved settings env to planApply`)
        desired = senv
      }
      const currentEnv = lp?.settingsEnv ?? null
      if (!currentEnv || JSON.stringify(sortKeys(currentEnv)) !== JSON.stringify(sortKeys(desired))) {
        actions.push({ kind: 'set-settings-env', settingsPath: join(dir, 'settings.json'), env: desired })
      }
    }
  }

  const block = renderRcBlock(m, p)
  let rcCurrent = ''
  try { rcCurrent = existsSync(p.rcFile) ? readFileSync(p.rcFile, 'utf8') : '' } catch { /* treat as empty */ }
  if (!rcCurrent.includes(block)) actions.push({ kind: 'rc-block', rcFile: p.rcFile, block })

  return actions
}

export async function executeApply(
  actions: ApplyAction[],
  opts: { backupRoot: string; stamp: string; dryRun?: boolean },
): Promise<{ backupDir: string | null; performed: string[] }> {
  const performed = actions.map(describe)
  if (opts.dryRun) return { backupDir: null, performed }

  const touched = actions.flatMap(a =>
    a.kind === 'set-mcp-servers' ? [a.configPath]
    : a.kind === 'rc-block' ? [a.rcFile]
    : a.kind === 'set-settings-env' ? [a.settingsPath]
    : [])
  const backupDir = touched.length ? await backupFiles(touched, opts.backupRoot, opts.stamp) : null

  for (const a of actions) {
    if (a.kind === 'create-profile-dir') {
      await mkdir(a.dir, { recursive: true })
    } else if (a.kind === 'set-mcp-servers') {
      if (a.agent === 'codex') {
        await mkdir(dirname(a.configPath), { recursive: true })
        await writeCodexMcpServers(a.configPath, a.servers)
        continue
      }
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(await readFile(a.configPath, 'utf8')) } catch { /* new file */ }
      cfg.mcpServers = a.servers
      await mkdir(dirname(a.configPath), { recursive: true })
      await atomicWrite(a.configPath, JSON.stringify(cfg, null, 2))
    } else if (a.kind === 'link') {
      try {
        const st = await lstat(a.from)
        if (!st.isSymbolicLink()) throw new Error(`refusing to replace non-symlink: ${a.from}`)
        await unlink(a.from)
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          if (typeof e.message === 'string' && e.message.startsWith('refusing')) throw e
        }
      }
      await symlink(a.to, a.from, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (a.kind === 'rc-block') {
      let rc = ''
      try { rc = await readFile(a.rcFile, 'utf8') } catch { /* new file */ }
      await mkdir(dirname(a.rcFile), { recursive: true })
      await atomicWrite(a.rcFile, upsertManagedBlock(rc, a.block))
    } else if (a.kind === 'set-settings-env') {
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(await readFile(a.settingsPath, 'utf8')) } catch { /* new file */ }
      cfg.env = a.env
      await mkdir(dirname(a.settingsPath), { recursive: true })
      await atomicWrite(a.settingsPath, JSON.stringify(cfg, null, 2))
    } else if (a.kind === 'share-session-dir') {
      await mkdir(a.to, { recursive: true })
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try { st = await lstat(a.from) } catch { /* absent */ }
      if (st && !st.isSymbolicLink()) {
        await backupTree(a.from, opts.backupRoot, opts.stamp)
        await cp(a.from, a.to, { recursive: true, force: false, errorOnExist: false })
        await rm(a.from, { recursive: true, force: true })
      } else if (st && st.isSymbolicLink()) {
        await unlink(a.from)
      }
      await mkdir(dirname(a.from), { recursive: true })
      await symlink(a.to, a.from, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (a.kind === 'unshare-session-dir') {
      try { const st = await lstat(a.from); if (st.isSymbolicLink()) await unlink(a.from) } catch { /* absent */ }
      await mkdir(a.from, { recursive: true })
      if (existsSync(a.to)) await cp(a.to, a.from, { recursive: true, force: false, errorOnExist: false })
    }
  }
  return { backupDir, performed }
}

function describe(a: ApplyAction): string {
  switch (a.kind) {
    case 'set-mcp-servers': return `set mcpServers (${Object.keys(a.servers).length}) in ${a.configPath}`
    case 'create-profile-dir': return `create ${a.dir}`
    case 'link': return `link ${a.from} -> ${a.to}`
    case 'rc-block': return `update managed block in ${a.rcFile}`
    case 'set-settings-env': return `set settings env (${Object.keys(a.env).length}) in ${a.settingsPath}`
    case 'share-session-dir': return `share ${a.from} -> ${a.to}`
    case 'unshare-session-dir': return `unshare ${a.from} (seed from ${a.to})`
  }
}
