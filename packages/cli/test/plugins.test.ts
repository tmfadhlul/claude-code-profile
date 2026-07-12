import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'
import { loadManifest, type PluginRunner } from 'ccprofiles-core'

let home: string, calls: string[]
function fake(): PluginRunner {
  return {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
  }
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-plugins-')); calls = []
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } } }))
})
function run(...args: string[]): Promise<void> {
  const ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any), pluginRunner: fake() }
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('plugins cli', () => {
  it('add installs on the target profile and records it in the manifest', async () => {
    await run('adopt', '--yes')
    await run('plugins', 'add', 'ponytail@ponytail', '--profile', 'default')
    expect(calls).toContain('install ponytail@ponytail')
    const m = await loadManifest(join(home, '.ccprofiles'))
    expect(m.profiles.find(p => p.name === 'default')!.plugins).toContain('ponytail@ponytail')
    expect(m.marketplaces.ponytail.source).toBe('DietrichGebert/ponytail')
  })

  it('installs a plugin that is enabled but not actually installed (stale enabledPlugins)', async () => {
    // The reverted union-sharing feature wrote enabledPlugins entries into settings.json
    // WITHOUT installing files. Reconcile must derive "current" from installed_plugins.json,
    // not enabledPlugins — otherwise the install never runs and the plugin stays broken.
    await writeFile(join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
    await run('adopt', '--yes') // adopt records ponytail in the manifest (desired), from enabledPlugins
    await run('plugins', 'add', 'ponytail@ponytail', '--profile', 'default')
    expect(calls).toContain('add DietrichGebert/ponytail')
    expect(calls).toContain('install ponytail@ponytail')
  })

  it('apply reconciles all claude profiles against the manifest without changing it', async () => {
    await writeFile(join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
    await run('adopt', '--yes')
    await run('plugins', 'apply')
    expect(calls).toContain('install ponytail@ponytail')
  })

  it('add errors for an unknown marketplace without --marketplace', async () => {
    await run('adopt', '--yes')
    await expect(run('plugins', 'add', 'x@nope', '--profile', 'default')).rejects.toThrow(/marketplace/)
  })

  it('add rejects an explicitly-named codex profile without mutating the manifest', async () => {
    await mkdir(join(home, '.codex-x'), { recursive: true })
    await writeFile(join(home, '.codex-x', 'config.toml'), 'model = "gpt-5-codex"\n')
    await writeFile(join(home, '.codex-x', 'auth.json'), '{"tokens":{}}')
    await run('adopt', '--yes')
    await expect(run('plugins', 'add', 'ponytail@ponytail', '--marketplace', 'DietrichGebert/ponytail', '--profile', 'codex-x')).rejects.toThrow(/Claude-only/)
    const m = await loadManifest(join(home, '.ccprofiles'))
    expect(m.profiles.find(p => p.name === 'codex-x')!.plugins).toEqual([])
  })
})
