import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'
import type { PluginRunner } from 'ccprofiles-core'

let home: string, calls: string[], ctx: any
function fake(): PluginRunner {
  return {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
    update: async (_d, id) => { calls.push(`update ${id}`) },
  }
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uiplugins-')); calls = []
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
  await mkdir(join(home, '.claude-work'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } } }))
  ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any), pluginRunner: fake() }
})

describe('ui api: plugins', () => {
  it('GET /api/plugins returns the plugin matrix; POST adds + reconciles', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'POST', '/api/plugins', { id: 'ponytail@ponytail', source: 'DietrichGebert/ponytail', targets: ['default'] })
    expect(res._status).toBe(200)
    expect(calls).toContain('install ponytail@ponytail')
    const data = (await callApi(ctx, 'GET', '/api/plugins'))._json
    expect(data.marketplaces).toContain('ponytail')
    expect(data.profiles.find((p: any) => p.name === 'default').has).toContain('ponytail@ponytail')
    expect(data.profiles.find((p: any) => p.name === 'work').has).not.toContain('ponytail@ponytail')
  })

  it('POST without source for an unknown marketplace 400s', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'POST', '/api/plugins', { id: 'foo@nope', targets: ['default'] })
    expect(res._status).toBe(400)
  })

  it('POST rejects a codex target', async () => {
    await mkdir(join(home, '.codex-x'), { recursive: true })
    await writeFile(join(home, '.codex-x', 'config.toml'), 'model = "gpt-5-codex"\n')
    await writeFile(join(home, '.codex-x', 'auth.json'), '{"tokens":{}}')
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'POST', '/api/plugins', { id: 'ponytail@ponytail', source: 'DietrichGebert/ponytail', targets: ['codex-x'] })
    expect(res._status).toBe(400)
  })

  it('DELETE removes plugin and prunes an orphaned marketplace', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/plugins', { id: 'ponytail@ponytail', source: 'DietrichGebert/ponytail', targets: ['default'] })
    const del = await callApi(ctx, 'DELETE', '/api/plugins/ponytail@ponytail', { targets: ['default'] })
    expect(del._status).toBe(200)
    const data = (await callApi(ctx, 'GET', '/api/plugins'))._json
    expect(data.marketplaces).not.toContain('ponytail')
    expect(data.profiles.find((p: any) => p.name === 'default').has).not.toContain('ponytail@ponytail')
  })

  it('DELETE reconciles against live current state and calls uninstall', async () => {
    // seed settings.json (feeds adopt → manifest desired) AND installed_plugins.json (feeds
    // reconcile `current` — the fake runner never writes it, so this is the only way it's non-empty).
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
    await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user' }] } }))
    await callApi(ctx, 'POST', '/api/adopt')
    const adopted = (await callApi(ctx, 'GET', '/api/plugins'))._json
    expect(adopted.profiles.find((p: any) => p.name === 'default').has).toContain('ponytail@ponytail')

    const del = await callApi(ctx, 'DELETE', '/api/plugins/ponytail@ponytail', { targets: ['default'] })
    expect(del._status).toBe(200)
    expect(calls).toContain('uninstall ponytail@ponytail')
  })

  it('doctor reports plugin drift as fixable, and POST /api/fix updates every holder to latest', async () => {
    // reproduce the 2026-07-16 incident: the same plugin at two versions across profiles
    for (const [dir, version] of [['.claude', '13.10.4'], ['.claude-work', '13.11.0']] as const) {
      await mkdir(join(home, dir, 'plugins'), { recursive: true })
      await writeFile(join(home, dir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', version }] } }))
    }
    const doc = (await callApi(ctx, 'GET', '/api/doctor'))._json
    expect(doc.fixable).toBe(true)
    expect(doc.problems.some((p: string) => /claude-mem@thedotmack.*differs across profiles/.test(p))).toBe(true)

    const res = await callApi(ctx, 'POST', '/api/fix')
    expect(res._status).toBe(200)
    // both profiles hold the plugin, so both get updated to latest (the one already ahead no-ops)
    expect(calls.filter(c => c === 'update claude-mem@thedotmack').length).toBe(2)
    expect(res._json.fixed).toHaveLength(2)
  })

  it('doctor is not fixable and fix is a no-op when nothing is wrong', async () => {
    const doc = (await callApi(ctx, 'GET', '/api/doctor'))._json
    expect(doc.fixable).toBe(false)
    const res = await callApi(ctx, 'POST', '/api/fix')
    expect(res._json.fixed).toEqual([])
    expect(calls).toEqual([])
  })

  it('sync copies the plugin set between profiles and rejects a codex target', async () => {
    await mkdir(join(home, '.codex-x'), { recursive: true })
    await writeFile(join(home, '.codex-x', 'config.toml'), 'model = "gpt-5-codex"\n')
    await writeFile(join(home, '.codex-x', 'auth.json'), '{"tokens":{}}')
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/plugins', { id: 'ponytail@ponytail', source: 'DietrichGebert/ponytail', targets: ['default'] })
    const res = await callApi(ctx, 'POST', '/api/plugins/sync', { from: 'default', to: ['work'] })
    expect(res._status).toBe(200)
    const data = (await callApi(ctx, 'GET', '/api/plugins'))._json
    expect(data.profiles.find((p: any) => p.name === 'work').has).toContain('ponytail@ponytail')
    const bad = await callApi(ctx, 'POST', '/api/plugins/sync', { from: 'default', to: ['codex-x'] })
    expect(bad._status).toBe(400)
  })
})
