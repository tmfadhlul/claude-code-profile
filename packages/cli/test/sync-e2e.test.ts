import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSyncServer, parseManifest, serializeManifest } from 'ccprofiles-core'
import { buildProgram, makeContext } from '../src/context.js'
import { rcFileFor } from './helpers.js'

let macHome: string   // "mac" — the master device, runs the server
let winHome: string   // "second machine" — pairs and pulls
let server: Awaited<ReturnType<typeof startSyncServer>>

async function runOn(home: string, ...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeAll(async () => {
  macHome = await mkdtemp(join(tmpdir(), 'ccp-mac-'))
  winHome = await mkdtemp(join(tmpdir(), 'ccp-win-'))

  // master: two profiles, a skill, a secret
  await mkdir(join(macHome, '.claude', 'skills', 'graphify'), { recursive: true })
  await writeFile(join(macHome, '.claude', 'skills', 'graphify', 'SKILL.md'), '# graphify')
  await writeFile(join(macHome, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    oauthAccount: { emailAddress: 'me@personal.com' },
  }))
  await mkdir(join(macHome, '.claude-office'))
  await writeFile(join(macHome, '.claude-office', '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  }))
  await runOn(macHome, 'adopt', '--yes')
  await runOn(macHome, 'secrets', 'set', 'z-token', 'sk-secret-value')

  // ensure the mac manifest has a hub so assets travel
  const manifestPath = join(macHome, '.ccprofiles', 'manifest.yaml')
  const m = parseManifest(await readFile(manifestPath, 'utf8'))
  m.hub = 'default'
  await writeFile(manifestPath, serializeManifest(m))

  const macCtx = makeContext({ CCPROFILES_TEST_HOME: macHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  const { secretsStore } = await import('../src/commands/secrets.js')
  server = await startSyncServer({
    manifestRoot: macCtx.manifestRoot,
    platform: macCtx.platform,
    pin: '424242',
    allowSecrets: true,
    secretValues: async names => {
      const store = await secretsStore(macCtx)
      const wanted = names.length ? names : await store.list()
      const out: Record<string, string> = {}
      for (const n of wanted) { const v = await store.get(n); if (v !== null) out[n] = v }
      return out
    },
  })
})
afterAll(async () => { await server.close() })

describe('cross-device sync', () => {
  it('pair → sync --with-secrets replicates the whole setup', async () => {
    await runOn(winHome, 'pair', '127.0.0.1', '--port', String(server.port), '--pin', '424242', '--name', 'mac')
    expect(await runOn(winHome, 'devices')).toContain('mac')

    const out = await runOn(winHome, 'sync', '--from', 'mac', '--with-secrets')
    expect(out).toContain('pulled manifest: 2 profiles')

    // manifest landed and was applied: profiles exist, mcp configured, launcher written, skill file synced
    expect(existsSync(join(winHome, '.claude-office', '.claude.json'))).toBe(true)
    const office = JSON.parse(await readFile(join(winHome, '.claude-office', '.claude.json'), 'utf8'))
    expect(Object.keys(office.mcpServers)).toEqual(['playwright'])
    expect(await readFile(rcFileFor(winHome), 'utf8')).toContain('cl-office')
    expect(await readFile(join(winHome, '.claude', 'skills', 'graphify', 'SKILL.md'), 'utf8')).toBe('# graphify')

    // secret arrived in the client's store
    expect(await runOn(winHome, 'secrets', 'get', 'z-token')).toBe('sk-secret-value')
  })

  it('bundle export/import replicates offline', async () => {
    const bundleFile = join(macHome, 'setup.ccb')
    await runOn(macHome, 'export', bundleFile)
    const fresh = await mkdtemp(join(tmpdir(), 'ccp-fresh-'))
    const out = await runOn(fresh, 'import', bundleFile)
    expect(out).toContain('2 profiles')
    expect(existsSync(join(fresh, '.claude-office', '.claude.json'))).toBe(true)
    expect(await readFile(join(fresh, '.claude', 'skills', 'graphify', 'SKILL.md'), 'utf8')).toBe('# graphify')
  })
})
