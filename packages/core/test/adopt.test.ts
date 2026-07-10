import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, preserveSecretRefs } from '../src/adopt.js'
import { detectPlatform } from '../src/platform.js'
import { discoverProfiles, type LiveProfile } from '../src/discovery.js'
import type { Manifest } from '../src/manifest.js'

const p = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const live: LiveProfile[] = [
  { agent: 'claude', dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
    account: 'a@b.c', links: {}, settingsEnv: {},
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
  { agent: 'claude', dirName: '.claude-oauth', dir: '/Users/x/.claude-oauth', configPath: '/Users/x/.claude-oauth/.claude.json',
    account: 'a@b.c', links: { skills: '/Users/x/.claude/skills' }, settingsEnv: {},
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] } } },
]

describe('buildManifest', () => {
  const m = buildManifest(live, p)
  it('names profiles and launchers', () => {
    expect(m.profiles.map(x => [x.name, x.launcher])).toEqual([['default', null], ['oauth', 'cl-oauth']])
  })
  it('merges mcp defs and per-profile lists', () => {
    expect(Object.keys(m.mcpServers).sort()).toEqual(['playwright', 'shadcn'])
    expect(m.profiles.find(x => x.name === 'oauth')!.mcp.sort()).toEqual(['playwright', 'shadcn'])
  })
  it('marks hub links', () => {
    expect(m.hub).toBe('default')
    expect(m.profiles.find(x => x.name === 'oauth')!.links.skills).toBe('hub')
  })
  it('templates dirs', () => {
    expect(m.profiles.find(x => x.name === 'oauth')!.dir).toBe('{home}/.claude-oauth')
  })
  it('imports live settingsEnv into the manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-adopt-senv-'))
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude.json'), '{}')
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }))
    const m = buildManifest(await discoverProfiles(home), detectPlatform({ home, shell: '/bin/zsh' }))
    expect(m.profiles[0].settingsEnv.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
  })
})

describe('preserveSecretRefs', () => {
  function manifestWith(settingsEnv: Record<string, string>): Manifest {
    return {
      version: 1, hub: null, mcpServers: {},
      profiles: [{ name: 'default', dir: '{home}/.claude', launcher: null, auth: 'env', env: {}, links: {}, mcp: [], settingsEnv, skipPermissions: false, sharedSessions: false }],
    }
  }

  it('restores a secret:// ref when the freshly-discovered plaintext value matches the resolved secret', async () => {
    const oldM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://anthropic-auth-token-default' })
    const newM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'plain-tok-1' })
    await preserveSecretRefs(newM, oldM, async name => (name === 'anthropic-auth-token-default' ? 'plain-tok-1' : null))
    expect(newM.profiles[0].settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://anthropic-auth-token-default')
  })

  it('leaves the new plaintext value alone when it no longer matches the resolved secret', async () => {
    const oldM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://anthropic-auth-token-default' })
    const newM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'someone-changed-it' })
    await preserveSecretRefs(newM, oldM, async name => (name === 'anthropic-auth-token-default' ? 'plain-tok-1' : null))
    expect(newM.profiles[0].settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('someone-changed-it')
  })

  it('leaves the new plaintext value alone when the referenced secret no longer exists', async () => {
    const oldM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://gone' })
    const newM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'plain-tok-1' })
    await preserveSecretRefs(newM, oldM, async () => null)
    expect(newM.profiles[0].settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('plain-tok-1')
  })

  it('ignores profiles that did not exist in the old manifest', async () => {
    const oldM = manifestWith({})
    oldM.profiles = []
    const newM = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'plain-tok-1' })
    await preserveSecretRefs(newM, oldM, async () => 'plain-tok-1')
    expect(newM.profiles[0].settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('plain-tok-1')
  })
})
