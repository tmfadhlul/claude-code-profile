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
    // seed live settings.json so discoverProfiles sees ponytail@ponytail already enabled — the
    // fake runner never writes settings.json, so this is the only way `current` is non-empty.
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
    await callApi(ctx, 'POST', '/api/adopt')
    const adopted = (await callApi(ctx, 'GET', '/api/plugins'))._json
    expect(adopted.profiles.find((p: any) => p.name === 'default').has).toContain('ponytail@ponytail')

    const del = await callApi(ctx, 'DELETE', '/api/plugins/ponytail@ponytail', { targets: ['default'] })
    expect(del._status).toBe(200)
    expect(calls).toContain('uninstall ponytail@ponytail')
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
