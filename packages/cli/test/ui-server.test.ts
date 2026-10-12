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

  it('streams steps then the final result when asked for progress', async () => {
    const post = async (path: string) => {
      const r = await fetch(base + path, { method: 'POST', headers: { 'x-ccp-token': token, 'x-ccp-progress': '1' } })
      expect(r.headers.get('content-type')).toContain('ndjson')
      return (await r.text()).trim().split('\n').map(l => JSON.parse(l))
    }
    // no manifest yet → the error rides in the final line, not the HTTP status
    expect((await post('/api/apply')).at(-1)).toMatchObject({ status: 409 })
    await post('/api/adopt')
    const lines = await post('/api/apply')
    expect(lines[0]).toEqual({ step: 'Planning changes' })
    expect(lines.at(-1)).toMatchObject({ status: 200, body: { performed: expect.any(Array) } })
  })
})
