import { lstat, mkdir, readFile, symlink, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Manifest, McpServerDef } from './manifest.js'
import type { LiveProfile } from './discovery.js'
import { renderPath, type Platform } from './platform.js'
import { renderRcBlock, upsertManagedBlock } from './rcblock.js'
import { atomicWrite, backupFiles } from './fsutil.js'

export type ApplyAction =
  | { kind: 'set-mcp-servers'; configPath: string; servers: Record<string, McpServerDef> }
  | { kind: 'create-profile-dir'; dir: string }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'rc-block'; rcFile: string; block: string }
  | { kind: 'set-settings-env'; settingsPath: string; env: Record<string, string> }

function configPathFor(dir: string, home: string): string {
  return dir === join(home, '.claude') ? join(home, '.claude.json') : join(dir, '.claude.json')
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

const SECRET_PREFIX = 'secret://'

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

export function planApply(m: Manifest, live: LiveProfile[], p: Platform, resolvedSettingsEnv?: Record<string, Record<string, string>>): ApplyAction[] {
  const actions: ApplyAction[] = []
  const hubProfile = m.profiles.find(x => x.name === m.hub) ?? null

  for (const pr of m.profiles) {
    const dir = renderPath(pr.dir, p)
    const lp = live.find(l => l.dir === dir) ?? null
    const desired: Record<string, McpServerDef> = {}
    for (const name of pr.mcp) desired[name] = m.mcpServers[name]

    if (!lp) actions.push({ kind: 'create-profile-dir', dir })

    const current = lp?.mcpServers ?? null
    if (!current || JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(desired))) {
      actions.push({ kind: 'set-mcp-servers', configPath: configPathFor(dir, p.home), servers: desired })
    }

    for (const [entry, target] of Object.entries(pr.links)) {
      const to = target === 'hub' && hubProfile
        ? join(renderPath(hubProfile.dir, p), entry)
        : renderPath(target, p)
      const from = join(dir, entry)
      if (lp?.links[entry] === to) continue
      actions.push({ kind: 'link', from, to })
    }

    const senv = pr.settingsEnv ?? {} // literals in older tests may omit the field
    if (Object.keys(senv).length > 0) {
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
  }
}
