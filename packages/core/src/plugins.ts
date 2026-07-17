import { cp, lstat, mkdir, readlink, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface PluginRunner {
  marketplaceAdd(configDir: string, source: string): Promise<void>
  install(configDir: string, id: string): Promise<void>
  uninstall(configDir: string, id: string): Promise<void>
  /** `claude plugin update` — moves a plugin to the marketplace's latest. There is deliberately no
   *  version argument: the underlying CLI has none (see planPluginVersionDrift). */
  update(configDir: string, id: string): Promise<void>
}

export function marketplaceOf(id: string): string | null {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(at + 1) : null
}

/** One plugin installed at more than one version across profiles. */
export interface PluginVersionDrift {
  id: string
  /** profile name -> installed version, for the profiles that have this plugin at a known version */
  byProfile: Record<string, string>
}

/**
 * Find plugins installed at DIFFERENT versions across profiles.
 *
 * Why this exists: profiles are separate config dirs, but some plugins keep global singleton state
 * outside them and are therefore shared by every profile at once. claude-mem is the motivating case
 * — all profiles share one `~/.claude-mem/` worker, and its hooks compare their own plugin version
 * against the running worker's. When two profiles sit at different versions, each session decides
 * the other's worker is stale, kills it and respawns its own, forever. On 2026-07-16 that loop
 * orphaned 1,246 chroma-mcp processes and exhausted 40GB of swap. Presence parity (which this tool
 * already enforced) is not enough; version parity is the real invariant.
 *
 * A profile missing the plugin entirely is NOT drift — that's planPluginReconcile's job. Only ids
 * present at 2+ distinct known versions are reported.
 */
export function planPluginVersionDrift(
  profiles: { name: string; versions: Record<string, string> }[],
): PluginVersionDrift[] {
  const byId = new Map<string, Record<string, string>>()
  for (const p of profiles) {
    for (const [id, version] of Object.entries(p.versions)) {
      if (!byId.has(id)) byId.set(id, {})
      byId.get(id)![p.name] = version
    }
  }
  const out: PluginVersionDrift[] = []
  for (const [id, byProfile] of byId) {
    if (new Set(Object.values(byProfile)).size > 1) out.push({ id, byProfile })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function planPluginReconcile(
  desired: string[],
  current: string[],
  /** ids to re-level to the marketplace's latest (from planPluginVersionDrift); ignored unless the
   *  id is both desired and already installed — installing/uninstalling takes precedence. */
  updateIds: string[] = [],
): { install: string[]; uninstall: string[]; update: string[] } {
  const d = new Set(desired), c = new Set(current), u = new Set(updateIds)
  return {
    install: desired.filter(id => !c.has(id)),
    uninstall: current.filter(id => !d.has(id)),
    update: desired.filter(id => c.has(id) && u.has(id)),
  }
}

export async function reconcileProfilePlugins(opts: {
  configDir: string
  desired: string[]
  current: string[]
  marketplaces: Record<string, { source: string }>
  runner: PluginRunner
  /** ids drifting across profiles — update them here so every profile lands on the same latest. */
  updateIds?: string[]
}): Promise<string[]> {
  const log: string[] = []
  const { install, uninstall, update } = planPluginReconcile(opts.desired, opts.current, opts.updateIds)
  for (const id of uninstall) { await opts.runner.uninstall(opts.configDir, id); log.push(`uninstall ${id}`) }
  const added = new Set<string>()
  for (const id of install) {
    const mkt = marketplaceOf(id)
    if (mkt && !added.has(mkt)) {
      const src = opts.marketplaces[mkt]?.source
      if (src) { await opts.runner.marketplaceAdd(opts.configDir, src); added.add(mkt); log.push(`add ${src}`) }
    }
    await opts.runner.install(opts.configDir, id); log.push(`install ${id}`)
  }
  for (const id of update) { await opts.runner.update(opts.configDir, id); log.push(`update ${id}`) }
  return log
}

/** If a profile's plugins/ is a legacy symlink into the old shared pool, restore it to a real dir. */
export async function restoreLegacyPluginSymlink(pluginsDir: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof lstat>> | null = null
  try { st = await lstat(pluginsDir) } catch { return false }
  if (!st.isSymbolicLink()) return false
  const target = await readlink(pluginsDir)
  // Never unlink-and-empty when the pool target is gone — that would silently leave the
  // profile with a permanently empty plugins/ and no way to recover the original content.
  // Leave the symlink in place and fail loudly instead.
  if (!existsSync(target)) {
    throw new Error(`cannot restore ${pluginsDir}: symlink target ${target} does not exist — leaving the symlink in place`)
  }
  await unlink(pluginsDir)
  await mkdir(pluginsDir, { recursive: true })
  await cp(target, pluginsDir, { recursive: true, force: false, errorOnExist: false })
  return true
}
