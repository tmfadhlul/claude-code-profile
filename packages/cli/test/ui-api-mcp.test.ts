import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uimcp-'))
  await mkdir(join(home, '.claude')); await mkdir(join(home, '.claude-work'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await callApi(ctx, 'POST', '/api/adopt')
})

describe('ui api: mcp', () => {
  it('GET returns matrix', async () => {
    const r = await callApi(ctx, 'GET', '/api/mcp')
    expect(r._json.servers).toContain('playwright')
    expect(r._json.profiles.find((p: any) => p.name === 'default').has).toContain('playwright')
    expect(r._json.profiles.find((p: any) => p.name === 'work').has).not.toContain('playwright')
  })
  it('POST adds a server to all and writes live config', async () => {
    await callApi(ctx, 'POST', '/api/mcp', { name: 'shadcn', command: 'npx', args: ['shadcn@latest', 'mcp'], targets: 'all' })
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(cfg.mcpServers.shadcn.args).toEqual(['shadcn@latest', 'mcp'])
  })
  it('sync copies mcp set between profiles', async () => {
    await callApi(ctx, 'POST', '/api/mcp/sync', { from: 'default', to: ['work'] })
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
  })
  it('DELETE removes from targets', async () => {
    await callApi(ctx, 'DELETE', '/api/mcp/playwright', { targets: 'all' })
    const r = await callApi(ctx, 'GET', '/api/mcp')
    expect(r._json.servers).not.toContain('playwright')
  })
})
