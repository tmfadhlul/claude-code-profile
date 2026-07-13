import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSyncServer, parseManifest, serializeManifest, saveDevices, pairWithServer } from 'ccprofiles-core'
import { makeContext } from '../src/context.js'
import { secretsStore } from '../src/commands/secrets.js'
import { callApi } from './ui-helpers.js'

let peerHome: string, myHome: string, server: any, myCtx: any, peerCtx: any
beforeEach(async () => {
  peerHome = await mkdtemp(join(tmpdir(), 'ccp-peer-'))
  await mkdir(join(peerHome, '.claude', 'skills'), { recursive: true })
  await writeFile(join(peerHome, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  peerCtx = makeContext({ CCPROFILES_TEST_HOME: peerHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await callApi(peerCtx, 'POST', '/api/adopt')
  const mp = join(peerCtx.manifestRoot, 'manifest.yaml')
  const m = parseManifest(await readFile(mp, 'utf8')); m.hub = 'default'; await writeFile(mp, serializeManifest(m))
  server = await startSyncServer({
    manifestRoot: peerCtx.manifestRoot, platform: peerCtx.platform, pin: '111222',
    allowSecrets: true,
    secretValues: async names => {
      const store = await secretsStore(peerCtx)
      const wanted = names.length ? names : await store.list()
      const out: Record<string, string> = {}
      for (const n of wanted) { const v = await store.get(n); if (v !== null) out[n] = v }
      return out
    },
  })

  myHome = await mkdtemp(join(tmpdir(), 'ccp-me-'))
  myCtx = makeContext({ CCPROFILES_TEST_HOME: myHome, CCPROFILES_PASSPHRASE: 'pw2', SHELL: '/bin/zsh' } as any)
  const device = await pairWithServer('127.0.0.1', server.port, '111222', 'peer')
  await saveDevices(myCtx.manifestRoot, [device])
})
afterEach(async () => { await server.close() })

describe('ui api: sync', () => {
  it('POST /api/pair pairs with a live server and persists the device', async () => {
    const res = await callApi(myCtx, 'POST', '/api/pair', { host: '127.0.0.1', port: server.port, pin: '111222', name: 'peer2' })
    expect(res._status).toBe(200)
    expect(res._json.name).toBe('peer2')
    expect((await callApi(myCtx, 'GET', '/api/devices'))._json.map((d: any) => d.name)).toContain('peer2')
  })

  it('POST /api/pair rejects a wrong pin without persisting', async () => {
    const res = await callApi(myCtx, 'POST', '/api/pair', { host: '127.0.0.1', port: server.port, pin: '999999', name: 'bad' })
    expect(res._status).toBe(400)
    expect((await callApi(myCtx, 'GET', '/api/devices'))._json.map((d: any) => d.name)).not.toContain('bad')
  })

  it('POST /api/pair validates inputs', async () => {
    expect((await callApi(myCtx, 'POST', '/api/pair', { host: '', port: 1, pin: 'x' }))._status).toBe(400)
    expect((await callApi(myCtx, 'POST', '/api/pair', { host: 'h', port: 99999999, pin: 'x' }))._status).toBe(400)
  })

  it('lists devices and pulls a manifest', async () => {
    expect((await callApi(myCtx, 'GET', '/api/devices'))._json.map((d: any) => d.name)).toContain('peer')
    const res = await callApi(myCtx, 'POST', '/api/sync', { from: 'peer' })
    expect(res._json.performed.join('\n')).toMatch(/set mcpServers/)
    expect(existsSync(join(myHome, '.claude.json'))).toBe(true)
  })

  it('aborts without touching local state when a settingsEnv secret ref cannot resolve, but succeeds withSecrets', async () => {
    // give the peer manifest a settingsEnv secret ref and put the secret into the peer's store
    const mp = join(peerCtx.manifestRoot, 'manifest.yaml')
    const m = parseManifest(await readFile(mp, 'utf8'))
    m.profiles[0].settingsEnv = { ANTHROPIC_AUTH_TOKEN: 'secret://peer-tok' }
    await writeFile(mp, serializeManifest(m))
    const peerStore = await secretsStore(peerCtx)
    await peerStore.set('peer-tok', 'sk-peer-secret')

    const myManifestPath = join(myCtx.manifestRoot, 'manifest.yaml')

    // without secrets: preflight must fail (secret not found) *before* saving anything locally
    const res409 = await callApi(myCtx, 'POST', '/api/sync', { from: 'peer' })
    expect(res409._status).toBe(409)
    expect(res409._json.error).toMatch(/secret not found/)
    expect(existsSync(myManifestPath)).toBe(false)

    // with secrets: the peer's secret is fetched+stored first, so the preflight (and apply) succeed
    const res200 = await callApi(myCtx, 'POST', '/api/sync', { from: 'peer', withSecrets: true })
    expect(res200._status).toBe(200)
    expect(existsSync(myManifestPath)).toBe(true)
    const myStore = await secretsStore(myCtx)
    expect(await myStore.get('peer-tok')).toBe('sk-peer-secret')
    const settingsPath = join(myHome, '.claude', 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-peer-secret')
  })
})
