import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'
import { parseManifest, serializeManifest } from 'ccprofiles-core'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uiapi-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: adopt/profiles/status/apply/doctor', () => {
  it('adopt then profiles lists the discovered profile', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'GET', '/api/profiles')
    expect(res._json.find((p: any) => p.name === 'default').account).toBe('a@b.c')
  })
  it('status is not-in-sync before apply, in-sync after', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    expect((await callApi(ctx, 'GET', '/api/status'))._json.inSync).toBe(false)
    await callApi(ctx, 'POST', '/api/apply')
    expect((await callApi(ctx, 'GET', '/api/status'))._json.inSync).toBe(true)
  })
  it('create profile via POST', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/profiles', { name: 'work', from: 'default' })
    const names = (await callApi(ctx, 'GET', '/api/profiles'))._json.map((p: any) => p.name)
    expect(names).toContain('work')
  })
  it('status without a manifest 409s with a hint', async () => {
    const res = await callApi(ctx, 'GET', '/api/status')
    expect(res._status).not.toBe(200)
    expect(res._json.error).toMatch(/no manifest/)
  })
  it('doctor returns problems array', async () => {
    const res = await callApi(ctx, 'GET', '/api/doctor')
    expect(Array.isArray(res._json.problems)).toBe(true)
  })
  it('profiles include env, links, and mcpNames from the manifest', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'PATCH', '/api/profiles/default', { env: { FOO: 'bar' } })
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.env).toEqual({ FOO: 'bar' })
    expect(row.mcpNames).toEqual(['playwright'])
    expect(row.links).toEqual({})
  })
  it('DELETE removes profile from manifest and rc but keeps the dir', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/profiles', { name: 'work' })
    expect(await readFile(ctx.platform.rcFile, 'utf8')).toContain('cl-work')
    const del = await callApi(ctx, 'DELETE', '/api/profiles/work')
    expect(del._json.ok).toBe(true)
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'work')
    expect(row.adopted).toBe(false)
    expect(existsSync(join(home, '.claude-work'))).toBe(true)
    expect(await readFile(ctx.platform.rcFile, 'utf8')).not.toContain('cl-work')
  })
  it('DELETE unknown profile 404s', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    expect((await callApi(ctx, 'DELETE', '/api/profiles/nope'))._status).toBe(404)
  })
  it('DELETE the hub profile is rejected', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const mp = join(ctx.manifestRoot, 'manifest.yaml')
    const m = parseManifest(await readFile(mp, 'utf8'))
    m.hub = 'default'
    await writeFile(mp, serializeManifest(m))
    const res = await callApi(ctx, 'DELETE', '/api/profiles/default')
    expect(res._status).toBe(400)
    expect(res._json.error).toMatch(/hub/)
  })
})
