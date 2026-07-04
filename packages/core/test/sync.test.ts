import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSyncServer, MAX_PIN_ATTEMPTS } from '../src/syncserver.js'
import { pairWithServer, fetchRemote, fetchSecrets } from '../src/syncclient.js'
import { exportBundle, importBundle } from '../src/bundle.js'
import { detectPlatform } from '../src/platform.js'
import { discoverProfiles } from '../src/discovery.js'
import { buildManifest } from '../src/adopt.js'
import { serializeManifest } from '../src/manifest.js'

let home: string, manifestRoot: string
let server: Awaited<ReturnType<typeof startSyncServer>>

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-sync-'))
  manifestRoot = join(home, '.ccprofiles')
  await mkdir(join(home, '.claude', 'skills', 'demo'), { recursive: true })
  await writeFile(join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo skill')
  await writeFile(join(home, '.claude', 'CLAUDE.md'), '# rules')
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
  const m = buildManifest(await discoverProfiles(home), p)
  m.hub = 'default' // single profile — make it the hub explicitly
  await mkdir(manifestRoot, { recursive: true })
  await writeFile(join(manifestRoot, 'manifest.yaml'), serializeManifest(m))
  server = await startSyncServer({
    manifestRoot, platform: p, pin: '111222',
    allowSecrets: true,
    secretValues: async names => Object.fromEntries(names.map(n => [n, `value-of-${n}`])),
  })
})
afterAll(async () => { await server.close() })

describe('LAN sync', () => {
  it('pairs with correct PIN and pulls manifest + assets', async () => {
    const device = await pairWithServer('127.0.0.1', server.port, '111222', 'test-peer')
    const { manifestYaml, assets } = await fetchRemote(device)
    expect(manifestYaml).toContain('playwright')
    expect(assets['hub/skills/demo/SKILL.md']).toBe('# demo skill')
    expect(assets['profiles/default/CLAUDE.md']).toBe('# rules')
    const secrets = await fetchSecrets(device, ['api-key'])
    expect(secrets['api-key']).toBe('value-of-api-key')
  })
  it('rejects wrong PIN', async () => {
    await expect(pairWithServer('127.0.0.1', server.port, '999999', 'evil')).rejects.toThrow(/pin/i)
  })
  it('rejects unknown token', async () => {
    const device = { name: 'x', host: '127.0.0.1', port: server.port, token: 'bogus', key: Buffer.alloc(32).toString('base64') }
    await expect(fetchRemote(device)).rejects.toThrow(/unknown token/)
  })
})

describe('PIN brute-force lockout', () => {
  it('locks pairing after MAX_PIN_ATTEMPTS wrong PINs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-lock-'))
    const p = detectPlatform({ osKind: process.platform as any, home: root, shell: '/bin/zsh' })
    const s = await startSyncServer({ manifestRoot: root, platform: p, pin: '111222' })
    try {
      // MAX_PIN_ATTEMPTS wrong tries all report a pin mismatch
      for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
        await expect(pairWithServer('127.0.0.1', s.port, '000000', 'attacker')).rejects.toThrow(/pin mismatch/i)
      }
      // now locked — even the CORRECT pin is refused
      await expect(pairWithServer('127.0.0.1', s.port, '111222', 'me')).rejects.toThrow(/locked/i)
    } finally {
      await s.close()
    }
  })
})

describe('bundle', () => {
  it('round-trips', () => {
    const buf = exportBundle('version: 1', { 'hub/skills/a.md': 'hi' })
    expect(importBundle(buf)).toEqual({ v: 1, manifestYaml: 'version: 1', assets: { 'hub/skills/a.md': 'hi' } })
  })
  it('rejects garbage with a friendly message', () => {
    expect(() => importBundle(Buffer.from('nope'))).toThrow(/not a ccprofiles bundle/)
  })
  it('unreachable server gives an actionable error', async () => {
    await expect(pairWithServer('127.0.0.1', 1, '111111', 'x')).rejects.toThrow(/cannot reach 127\.0\.0\.1:1.*ccp serve/)
  })
})
