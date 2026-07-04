import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSyncServer, parseManifest, serializeManifest, saveDevices, pairWithServer } from 'ccprofiles-core'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'

let peerHome: string, myHome: string, server: any, myCtx: any
beforeEach(async () => {
  peerHome = await mkdtemp(join(tmpdir(), 'ccp-peer-'))
  await mkdir(join(peerHome, '.claude', 'skills'), { recursive: true })
  await writeFile(join(peerHome, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  const peerCtx = makeContext({ CCPROFILES_TEST_HOME: peerHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await callApi(peerCtx, 'POST', '/api/adopt')
  const mp = join(peerCtx.manifestRoot, 'manifest.yaml')
  const m = parseManifest(await readFile(mp, 'utf8')); m.hub = 'default'; await writeFile(mp, serializeManifest(m))
  server = await startSyncServer({ manifestRoot: peerCtx.manifestRoot, platform: peerCtx.platform, pin: '111222' })

  myHome = await mkdtemp(join(tmpdir(), 'ccp-me-'))
  myCtx = makeContext({ CCPROFILES_TEST_HOME: myHome, CCPROFILES_PASSPHRASE: 'pw2', SHELL: '/bin/zsh' } as any)
  const device = await pairWithServer('127.0.0.1', server.port, '111222', 'peer')
  await saveDevices(myCtx.manifestRoot, [device])
})
afterEach(async () => { await server.close() })

describe('ui api: sync', () => {
  it('lists devices and pulls a manifest', async () => {
    expect((await callApi(myCtx, 'GET', '/api/devices'))._json.map((d: any) => d.name)).toContain('peer')
    const res = await callApi(myCtx, 'POST', '/api/sync', { from: 'peer' })
    expect(res._json.performed.join('\n')).toMatch(/set mcpServers/)
    expect(existsSync(join(myHome, '.claude.json'))).toBe(true)
  })
})
