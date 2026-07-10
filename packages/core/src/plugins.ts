import { cp, lstat, mkdir, readlink, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface PluginRunner {
  marketplaceAdd(configDir: string, source: string): Promise<void>
  install(configDir: string, id: string): Promise<void>
  uninstall(configDir: string, id: string): Promise<void>
}

export function marketplaceOf(id: string): string | null {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(at + 1) : null
}

export function planPluginReconcile(desired: string[], current: string[]): { install: string[]; uninstall: string[] } {
  const d = new Set(desired), c = new Set(current)
  return { install: desired.filter(id => !c.has(id)), uninstall: current.filter(id => !d.has(id)) }
}

export async function reconcileProfilePlugins(opts: {
  configDir: string
  desired: string[]
  current: string[]
  marketplaces: Record<string, { source: string }>
  runner: PluginRunner
}): Promise<string[]> {
  const log: string[] = []
  const { install, uninstall } = planPluginReconcile(opts.desired, opts.current)
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
  return log
}

/** If a profile's plugins/ is a legacy symlink into the old shared pool, restore it to a real dir. */
export async function restoreLegacyPluginSymlink(pluginsDir: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof lstat>> | null = null
  try { st = await lstat(pluginsDir) } catch { return false }
  if (!st.isSymbolicLink()) return false
  const target = await readlink(pluginsDir)
  await unlink(pluginsDir)
  await mkdir(pluginsDir, { recursive: true })
  if (existsSync(target)) await cp(target, pluginsDir, { recursive: true, force: false, errorOnExist: false })
  return true
}
