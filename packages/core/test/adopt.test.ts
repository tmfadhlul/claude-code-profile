import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, preserveSecretRefs } from '../src/adopt.js'
import { detectPlatform } from '../src/platform.js'
import { discoverProfiles, type LiveProfile } from '../src/discovery.js'
import { parseManifest, serializeManifest, type Manifest } from '../src/manifest.js'
import { planApply } from '../src/apply.js'

const p = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const live: LiveProfile[] = [
  { agent: 'claude', dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
    account: 'a@b.c', links: {}, settingsEnv: {}, enabledPlugins: {}, marketplaces: {},
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
  { agent: 'claude', dirName: '.claude-oauth', dir: '/Users/x/.claude-oauth', configPath: '/Users/x/.claude-oauth/.claude.json',
    account: 'a@b.c', links: { skills: '/Users/x/.claude/skills' }, settingsEnv: {}, enabledPlugins: {}, marketplaces: {},
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

  it('recognizes a pooled session-dir symlink as sharedSessions instead of a plain link (claude)', () => {
    const sharedRoot = join(p.home, '.ccprofiles', 'shared')
    const liveWithPool: LiveProfile[] = [
      { agent: 'claude', dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
        account: 'a@b.c', links: {}, settingsEnv: {}, enabledPlugins: {}, marketplaces: {}, mcpServers: {} },
      { agent: 'claude', dirName: '.claude-work', dir: '/Users/x/.claude-work', configPath: '/Users/x/.claude-work/.claude.json',
        account: 'a@b.c',
        links: {
          skills: '/Users/x/.claude/skills',
          projects: join(sharedRoot, 'projects'),
          todos: join(sharedRoot, 'todos'),
          'shell-snapshots': join(sharedRoot, 'shell-snapshots'),
        },
        settingsEnv: {}, enabledPlugins: {}, marketplaces: {}, mcpServers: {} },
    ]
    const pooled = buildManifest(liveWithPool, p)
    const work = pooled.profiles.find(x => x.name === 'work')!
    expect(work.sharedSessions).toBe(true)
    expect(work.links.projects).toBeUndefined()
    expect(work.links.todos).toBeUndefined()
    expect(work.links['shell-snapshots']).toBeUndefined()
    // non-pool links are untouched, still routed through the hub
    expect(work.links.skills).toBe('hub')

    // regression guard: re-planning against the exact same live state must not try to
    // "unshare" (copy the whole shared pool back into the profile dir) — that was the bug.
    const actions = planApply(pooled, liveWithPool, p)
    expect(actions.some(a => a.kind === 'unshare-session-dir')).toBe(false)
  })

  it('recognizes a pooled session-dir symlink as sharedSessions instead of a plain link (codex)', () => {
    const sharedRoot = join(p.home, '.ccprofiles', 'shared')
    const liveWithPool: LiveProfile[] = [
      { agent: 'codex', dirName: '.codex', dir: '/Users/x/.codex', configPath: '/Users/x/.codex/config.toml',
        account: null, links: {}, settingsEnv: {}, enabledPlugins: {}, marketplaces: {}, mcpServers: {} },
      { agent: 'codex', dirName: '.codex-work', dir: '/Users/x/.codex-work', configPath: '/Users/x/.codex-work/config.toml',
        account: null,
        links: { sessions: join(sharedRoot, 'sessions') },
        settingsEnv: {}, enabledPlugins: {}, marketplaces: {}, mcpServers: {} },
    ]
    const pooled = buildManifest(liveWithPool, p)
    const work = pooled.profiles.find(x => x.name === 'codex-work')!
    expect(work.sharedSessions).toBe(true)
    expect(work.links.sessions).toBeUndefined()

    const actions = planApply(pooled, liveWithPool, p)
    expect(actions.some(a => a.kind === 'unshare-session-dir')).toBe(false)
  })

  it('drops plugin ids whose marketplace has no known_marketplaces entry (orphan filter)', () => {
    const liveWithPlugins: LiveProfile[] = [
      { agent: 'claude', dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
        account: 'a@b.c', links: {}, settingsEnv: {}, mcpServers: {},
        enabledPlugins: { 'good@known-mkt': true, 'orphan@stale-mkt': true, 'disabled@known-mkt': false },
        marketplaces: { 'known-mkt': { source: 'someorg/known-mkt' } } },
    ]
    const m = buildManifest(liveWithPlugins, p)
    expect(m.profiles[0].plugins).toEqual(['good@known-mkt'])
    expect(Object.keys(m.marketplaces)).toEqual(['known-mkt'])
    // must round-trip through parse/serialize without throwing "references undefined marketplace"
    expect(() => parseManifest(serializeManifest(m))).not.toThrow()
  })
})

describe('preserveSecretRefs', () => {
  function manifestWith(settingsEnv: Record<string, string>): Manifest {
    return {
      version: 1, hub: null, mcpServers: {}, marketplaces: {},
      profiles: [{ name: 'default', dir: '{home}/.claude', launcher: null, auth: 'env', env: {}, links: {}, mcp: [], settingsEnv, skipPermissions: false, sharedSessions: false, plugins: [] }],
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
