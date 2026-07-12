import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPluginReconcile, marketplaceOf, reconcileProfilePlugins, restoreLegacyPluginSymlink, type PluginRunner } from '../src/plugins.js'

describe('planPluginReconcile', () => {
  it('diffs desired vs current', () => {
    expect(planPluginReconcile(['a@m', 'b@m'], ['b@m', 'c@m'])).toEqual({ install: ['a@m'], uninstall: ['c@m'] })
  })
})

describe('marketplaceOf', () => {
  it('takes the part after the last @', () => {
    expect(marketplaceOf('claude-mem@thedotmack')).toBe('thedotmack')
    expect(marketplaceOf('bare')).toBeNull()
  })
})

function fakeRunner() {
  const calls: string[] = []
  const runner: PluginRunner = {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
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
