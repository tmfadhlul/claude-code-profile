import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPluginReconcile, planPluginVersionDrift, marketplaceOf, claudeMemCacheDirs, pruneStaleVersionDirs, repairInstalledPlugins, reconcileProfilePlugins, restoreLegacyPluginSymlink, type PluginRunner } from '../src/plugins.js'

describe('planPluginReconcile', () => {
  it('diffs desired vs current', () => {
    expect(planPluginReconcile(['a@m', 'b@m'], ['b@m', 'c@m'])).toEqual({ install: ['a@m'], uninstall: ['c@m'], update: [] })
  })

  it('updates a drifted id that is both desired and already installed', () => {
    expect(planPluginReconcile(['a@m', 'b@m'], ['a@m', 'b@m'], ['b@m'])).toEqual({ install: [], uninstall: [], update: ['b@m'] })
  })

  it('does not update an id it is already installing or uninstalling', () => {
    // install/uninstall already lands the latest version — an update on top would be a no-op at
    // best, and for an uninstalled id it would fail outright.
    expect(planPluginReconcile(['a@m'], ['b@m'], ['a@m', 'b@m'])).toEqual({ install: ['a@m'], uninstall: ['b@m'], update: [] })
  })
})

describe('planPluginVersionDrift', () => {
  const p = (name: string, versions: Record<string, string>) => ({ name, versions })

  it('flags a plugin installed at different versions across profiles', () => {
    expect(planPluginVersionDrift([
      p('claude', { 'claude-mem@thedotmack': '13.10.4' }),
      p('claude-oauth', { 'claude-mem@thedotmack': '13.11.0' }),
    ])).toEqual([{ id: 'claude-mem@thedotmack', byProfile: { claude: '13.10.4', 'claude-oauth': '13.11.0' } }])
  })

  it('is quiet when every profile agrees', () => {
    expect(planPluginVersionDrift([
      p('a', { 'x@m': '1.0.0' }), p('b', { 'x@m': '1.0.0' }), p('c', { 'x@m': '1.0.0' }),
    ])).toEqual([])
  })

  it('does not treat a profile simply missing the plugin as drift', () => {
    // that is planPluginReconcile's install/uninstall job, not a version problem
    expect(planPluginVersionDrift([p('a', { 'x@m': '1.0.0' }), p('b', {})])).toEqual([])
  })

  it('reports every drifting profile, not just the first pair', () => {
    const [d] = planPluginVersionDrift([
      p('a', { 'x@m': '1.0.0' }), p('b', { 'x@m': '2.0.0' }), p('c', { 'x@m': '3.0.0' }),
    ])
    expect(d.byProfile).toEqual({ a: '1.0.0', b: '2.0.0', c: '3.0.0' })
  })

  it('reproduces the 2026-07-16 incident: three profiles, one drifting plugin', () => {
    const drift = planPluginVersionDrift([
      p('claude', { 'claude-mem@thedotmack': '13.10.4', 'ponytail@ponytail': '4.8.4' }),
      p('claude-oauth', { 'claude-mem@thedotmack': '13.11.0', 'ponytail@ponytail': '4.8.4' }),
      p('claude-data-plb', { 'claude-mem@thedotmack': '13.10.4', 'ponytail@ponytail': '4.8.4' }),
    ])
    expect(drift.map(d => d.id)).toEqual(['claude-mem@thedotmack']) // ponytail agrees everywhere
  })
})

describe('marketplaceOf', () => {
  it('takes the part after the last @', () => {
    expect(marketplaceOf('claude-mem@thedotmack')).toBe('thedotmack')
    expect(marketplaceOf('bare')).toBeNull()
  })
})

describe('claudeMemCacheDirs', () => {
  it('finds claude-mem cache dirs on disk regardless of install scope (project-scope is invisible to installed_plugins.json)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-cmc-'))
    await mkdir(join(home, 'plugins', 'cache', 'thedotmack', 'claude-mem', '13.12.1'), { recursive: true })
    await mkdir(join(home, 'plugins', 'cache', 'other', 'something'), { recursive: true })
    expect(await claudeMemCacheDirs(home)).toEqual([join(home, 'plugins', 'cache', 'thedotmack', 'claude-mem')])
  })
  it('returns [] when the profile has no plugin cache', async () => {
    expect(await claudeMemCacheDirs(join(tmpdir(), 'ccp-none-xyz'))).toEqual([])
  })
})

describe('pruneStaleVersionDirs', () => {
  let cache: string
  const mk = async (...versions: string[]) => {
    cache = await mkdtemp(join(tmpdir(), 'ccp-prune-'))
    for (const v of versions) await mkdir(join(cache, v), { recursive: true })
  }

  it('keeps only the highest semver and deletes the rest (13.11.0 does NOT out-rank 13.12.1)', async () => {
    // the exact 2026-07-23 shape: a stale 13.11.0 dir alongside the pinned 13.12.1
    await mk('13.6.2', '13.9.2', '13.11.0', '13.12.1')
    const removed = await pruneStaleVersionDirs(cache)
    expect(removed.sort()).toEqual(['13.11.0', '13.6.2', '13.9.2'])
    expect(existsSync(join(cache, '13.12.1'))).toBe(true)
    expect(existsSync(join(cache, '13.11.0'))).toBe(false)
  })

  it('no-ops when a single version is present', async () => {
    await mk('13.12.1')
    expect(await pruneStaleVersionDirs(cache)).toEqual([])
    expect(existsSync(join(cache, '13.12.1'))).toBe(true)
  })

  it('leaves non-numeric (git-sha/"unknown") dirs untouched', async () => {
    await mk('unknown', '58578a456a83')
    expect(await pruneStaleVersionDirs(cache)).toEqual([])
    expect(existsSync(join(cache, 'unknown'))).toBe(true)
  })

  it('returns [] for a missing cache dir', async () => {
    expect(await pruneStaleVersionDirs(join(tmpdir(), 'ccp-does-not-exist-xyz'))).toEqual([])
  })
})

function fakeRunner() {
  const calls: string[] = []
  const runner: PluginRunner = {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    marketplaceUpdate: async (_d, n) => { calls.push(`mkt-update ${n}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
    update: async (_d, id) => { calls.push(`update ${id}`) },
  }
  return { runner, calls }
}

describe('reconcileProfilePlugins', () => {
  it('adds each new marketplace once, installs new, uninstalls removed', async () => {
    const { runner, calls } = fakeRunner()
    await reconcileProfilePlugins({
      configDir: '/cfg',
      desired: ['ponytail@ponytail', 'claude-mem@thedotmack'],
      current: ['old@thedotmack'],
      marketplaces: { ponytail: { source: 'o/ponytail' }, thedotmack: { source: 'o/cm' } },
      runner,
    })
    // uninstall first, then marketplace-add (once per new mkt) + install
    expect(calls).toEqual([
      'uninstall old@thedotmack',
      'add o/ponytail', 'install ponytail@ponytail',
      'add o/cm', 'install claude-mem@thedotmack',
    ])
  })

  it('updates a drifted plugin that is already installed', async () => {
    const { runner, calls } = fakeRunner()
    await reconcileProfilePlugins({
      configDir: '/cfg', desired: ['claude-mem@thedotmack'], current: ['claude-mem@thedotmack'],
      marketplaces: { thedotmack: { source: 'o/cm' } }, runner, updateIds: ['claude-mem@thedotmack'],
    })
    // marketplace refresh first: without it `claude plugin update` resolves "latest" from a stale
    // per-profile clone and no-ops, so cross-profile drift never converges.
    expect(calls).toEqual(['mkt-update thedotmack', 'update claude-mem@thedotmack'])
  })

  it('leaves a non-drifting profile completely alone', async () => {
    const { runner, calls } = fakeRunner()
    await reconcileProfilePlugins({
      configDir: '/cfg', desired: ['a@m'], current: ['a@m'],
      marketplaces: { m: { source: 'o/m' } }, runner, updateIds: [],
    })
    expect(calls).toEqual([])
  })

  it('does not re-add a marketplace already needed twice', async () => {
    const { runner, calls } = fakeRunner()
    await reconcileProfilePlugins({
      configDir: '/cfg', desired: ['a@m', 'b@m'], current: [],
      marketplaces: { m: { source: 'o/m' } }, runner,
    })
    expect(calls.filter(c => c === 'add o/m').length).toBe(1)
  })
})

describe('restoreLegacyPluginSymlink', () => {
  let home: string
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-legacy-')) })
  it('replaces a symlinked plugins/ with a real dir copied from the pool', async () => {
    const pool = join(home, 'pool'); await mkdir(pool, { recursive: true })
    await writeFile(join(pool, 'x.txt'), 'hi')
    const pdir = join(home, '.claude-a', 'plugins')
    await mkdir(join(home, '.claude-a'), { recursive: true })
    await symlink(pool, pdir, 'dir')
    const changed = await restoreLegacyPluginSymlink(pdir)
    expect(changed).toBe(true)
    expect((await lstat(pdir)).isSymbolicLink()).toBe(false)
    expect(existsSync(join(pdir, 'x.txt'))).toBe(true)
  })
  it('returns false for a real dir', async () => {
    const pdir = join(home, '.claude-b', 'plugins'); await mkdir(pdir, { recursive: true })
    expect(await restoreLegacyPluginSymlink(pdir)).toBe(false)
  })
  it('does not wipe the symlink into an empty dir when the pool target is missing', async () => {
    const pool = join(home, 'pool-gone') // never created — simulates a missing/removed pool target
    const pdir = join(home, '.claude-c', 'plugins')
    await mkdir(join(home, '.claude-c'), { recursive: true })
    await symlink(pool, pdir, 'dir')
    await expect(restoreLegacyPluginSymlink(pdir)).rejects.toThrow()
    // the symlink must still be intact — never replaced with an empty real dir
    expect((await lstat(pdir)).isSymbolicLink()).toBe(true)
  })
})

describe('repairInstalledPlugins', () => {
  // the 2026-08-30 shape: user scope updated to 13.18.0, prune deleted 13.15.2, and the
  // project-scope entry still points at the deleted dir — a Stop-hook error every session.
  const write = async (home: string, plugins: unknown) => {
    await mkdir(join(home, 'plugins'), { recursive: true })
    await writeFile(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
  }
  const read = async (home: string) =>
    JSON.parse(await readFile(join(home, 'plugins', 'installed_plugins.json'), 'utf8'))

  const entry = (home: string, scope: string, version: string) => ({
    scope, version, installPath: join(home, 'plugins', 'cache', 'thedotmack', 'claude-mem', version),
  })

  it('re-points a dangling entry at the surviving version and leaves live entries alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-repair-'))
    await mkdir(join(home, 'plugins', 'cache', 'thedotmack', 'claude-mem', '13.18.0'), { recursive: true })
    await write(home, { 'claude-mem@thedotmack': [entry(home, 'user', '13.18.0'), entry(home, 'project', '13.15.2')] })

    const log = await repairInstalledPlugins(home)
    expect(log).toHaveLength(1)
    const after = (await read(home)).plugins['claude-mem@thedotmack']
    expect(after.map((e: { version: string }) => e.version)).toEqual(['13.18.0', '13.18.0'])
    expect(after[1].installPath).toBe(entry(home, 'project', '13.18.0').installPath)
  })

  it('drops the entry when no version dir survived, and the id when no entry survives', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-repair-'))
    await write(home, { 'gone@mkt': [entry(home, 'user', '1.0.0')] })
    expect(await repairInstalledPlugins(home)).toHaveLength(1)
    expect((await read(home)).plugins['gone@mkt']).toBeUndefined()
  })

  it('dryRun reports without writing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-repair-'))
    await write(home, { 'gone@mkt': [entry(home, 'user', '1.0.0')] })
    expect(await repairInstalledPlugins(home, { dryRun: true })).toHaveLength(1)
    expect((await read(home)).plugins['gone@mkt']).toHaveLength(1)
  })

  it('returns [] for a missing or corrupt installed_plugins.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-repair-'))
    expect(await repairInstalledPlugins(home)).toEqual([])
    await mkdir(join(home, 'plugins'), { recursive: true })
    await writeFile(join(home, 'plugins', 'installed_plugins.json'), '{ not json')
    expect(await repairInstalledPlugins(home)).toEqual([])
  })
})
