import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { startUiServer } from '../src/ui/server.js'
import { newUiToken } from '../src/ui/token.js'

let uiDir: string, token: string, srv: Awaited<ReturnType<typeof startUiServer>>, base: string
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccp-uisrv-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  uiDir = await mkdtemp(join(tmpdir(), 'ccp-uidir-'))
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>ccprofiles</title>')
  token = newUiToken()
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  srv = await startUiServer(ctx, { token, uiDir })
  base = `http://127.0.0.1:${srv.port}`
})
afterEach(async () => { await srv.close() })

describe('ui server', () => {
  it('serves index.html at /', async () => {
    const r = await fetch(base + '/')
    expect(await r.text()).toContain('ccprofiles')
  })
  it('serves index.html for unknown SPA route', async () => {
    const r = await fetch(base + '/profiles')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('ccprofiles')
  })
  it('401s /api without token', async () => {
    const r = await fetch(base + '/api/profiles')
    expect(r.status).toBe(401)
  })
  it('serves /api with token', async () => {
    const r = await fetch(base + '/api/profiles', { headers: { 'x-ccp-token': token } })
    expect(r.status).toBe(200)
    expect(Array.isArray(await r.json())).toBe(true)
  })
  it('403s /api with a foreign Origin', async () => {
    const r = await fetch(base + '/api/profiles', { headers: { 'x-ccp-token': token, origin: 'http://evil.com' } })
    expect(r.status).toBe(403)
  })
})
