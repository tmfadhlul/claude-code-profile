import { cp, lstat, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, isAbsolute, relative } from 'node:path'
import type { Manifest, McpServerDef } from './manifest.js'
import type { LiveProfile } from './discovery.js'
import { renderPath, type Platform } from './platform.js'
import { renderRcBlock, upsertManagedBlock } from './rcblock.js'
import { atomicWrite, backupFiles, backupTree } from './fsutil.js'
import { writeCodexMcpServers } from './codex.js'
import { physicalLinkEntry } from './links.js'

export type ApplyAction =
  | { kind: 'set-mcp-servers'; agent: 'claude' | 'codex'; configPath: string; servers: Record<string, McpServerDef> }
  | { kind: 'create-profile-dir'; dir: string }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'rc-block'; rcFile: string; block: string }
  | { kind: 'set-settings-env'; settingsPath: string; env: Record<string, string> }
  | { kind: 'share-session-dir'; from: string; to: string }
  | { kind: 'unshare-session-dir'; from: string; to: string }
  | { kind: 'share-plugins-dir'; from: string; to: string }
  | { kind: 'unshare-plugins-dir'; from: string; to: string }
  | { kind: 'set-enabled-plugins'; settingsPath: string; enabledPlugins: Record<string, boolean> }

function configPathFor(dir: string, home: string, agent: 'claude' | 'codex'): string {
  if (agent === 'codex') return join(dir, 'config.toml')
  return dir === join(home, '.claude') ? join(home, '.claude.json') : join(dir, '.claude.json')
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

const SECRET_PREFIX = 'secret://'
const CLAUDE_SHARED_ENTRIES = ['projects', 'todos', 'shell-snapshots'] as const

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

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

  const pluginUnion: Record<string, boolean> = {}
  for (const pr of m.profiles) {
    if ((pr.agent ?? 'claude') !== 'claude' || !pr.sharedPlugins) continue
    const lp = live.find(l => l.dir === renderPath(pr.dir, p))
    for (const [k, v] of Object.entries(lp?.enabledPlugins ?? {})) if (v) pluginUnion[k] = true
  }

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
      const physicalEntry = physicalLinkEntry(agent, entry)
      const to = target === 'hub' && hubProfile
        ? join(renderPath(hubProfile.dir, p), physicalLinkEntry(hubProfile.agent ?? 'claude', entry))
        : renderPath(target, p)
      const from = join(dir, physicalEntry)
      if (from === to) continue
      if (isWithin(from, to) || isWithin(to, from))
        throw new Error(`unsafe link topology: ${from} -> ${to} (source and target must not contain each other)`)
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

    if (agent === 'claude') {
      const pfrom = join(dir, 'plugins')
      const pto = join(sharedRoot, 'plugins')
      const pluginLinked = lp?.links['plugins'] === pto
      if (pr.sharedPlugins && !pluginLinked) actions.push({ kind: 'share-plugins-dir', from: pfrom, to: pto })
      else if (!pr.sharedPlugins && pluginLinked) actions.push({ kind: 'unshare-plugins-dir', from: pfrom, to: pto })

      if (pr.sharedPlugins) {
        const currentEnabled = lp?.enabledPlugins ?? {}
        if (JSON.stringify(sortKeys(currentEnabled)) !== JSON.stringify(sortKeys(pluginUnion)))
          actions.push({ kind: 'set-enabled-plugins', settingsPath: join(dir, 'settings.json'), enabledPlugins: pluginUnion })
      }
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
    : a.kind === 'set-enabled-plugins' ? [a.settingsPath]
    : [])
  let backupDir = touched.length ? await backupFiles(touched, opts.backupRoot, opts.stamp) : null

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
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try {
        st = await lstat(a.from)
      } catch { /* absent */ }
      if (st && !st.isSymbolicLink()) {
        // Preserve profile-local assets, then merge unique entries into shared target.
        // Existing target files win name conflicts; complete source remains in backup.
        const treeBackup = await backupTree(a.from, opts.backupRoot, opts.stamp)
        if (treeBackup) backupDir ??= dirname(treeBackup)
        await mkdir(a.to, { recursive: true })
        await cp(a.from, a.to, { recursive: true, force: false, errorOnExist: false })
        await rm(a.from, { recursive: true, force: true })
      } else if (st) {
        await unlink(a.from)
      }
      await mkdir(a.to, { recursive: true })
      await mkdir(dirname(a.from), { recursive: true })
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
        const treeBackup = await backupTree(a.from, opts.backupRoot, opts.stamp)
        if (treeBackup) backupDir ??= dirname(treeBackup)
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
    } else if (a.kind === 'share-plugins-dir') {
      const poolExists = existsSync(a.to)
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try { st = await lstat(a.from) } catch { /* absent */ }
      if (st && st.isSymbolicLink()) {
        await unlink(a.from)
      } else if (st) {
        await backupTree(a.from, opts.backupRoot, opts.stamp)
        if (!poolExists) { await mkdir(dirname(a.to), { recursive: true }); await cp(a.from, a.to, { recursive: true }) } // seed
        await rm(a.from, { recursive: true, force: true })                                                             // adopt = no copy
      }
      if (!existsSync(a.to)) await mkdir(a.to, { recursive: true })
      await mkdir(dirname(a.from), { recursive: true })
      await symlink(a.to, a.from, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (a.kind === 'unshare-plugins-dir') {
      try { const st = await lstat(a.from); if (st.isSymbolicLink()) await unlink(a.from) } catch { /* absent */ }
      await mkdir(a.from, { recursive: true })
      if (existsSync(a.to)) await cp(a.to, a.from, { recursive: true, force: false, errorOnExist: false })
    } else if (a.kind === 'set-enabled-plugins') {
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(await readFile(a.settingsPath, 'utf8')) } catch { /* new file */ }
      cfg.enabledPlugins = a.enabledPlugins
      await mkdir(dirname(a.settingsPath), { recursive: true })
      await atomicWrite(a.settingsPath, JSON.stringify(cfg, null, 2))
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
    case 'share-plugins-dir': return `share plugins ${a.from} -> ${a.to}`
    case 'unshare-plugins-dir': return `unshare plugins ${a.from} (seed from ${a.to})`
    case 'set-enabled-plugins': return `set enabledPlugins (${Object.keys(a.enabledPlugins).length}) in ${a.settingsPath}`
  }
}
