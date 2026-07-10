import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planApply, executeApply, resolveSettingsEnv } from '../src/apply.js'
import { discoverProfiles } from '../src/discovery.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-home-'))
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {}, otherKey: 'preserve-me' }))
})

function manifest(): Manifest {
  return {
    version: 1, hub: 'default',
    profiles: [
      { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, settingsEnv: {},
        links: {}, mcp: ['playwright'], skipPermissions: false, sharedSessions: false, plugins: [] },
      { name: 'new', dir: '{home}/.claude-new', launcher: 'cl-new', auth: 'env', env: {}, settingsEnv: {},
        links: { skills: 'hub' }, mcp: ['playwright'], skipPermissions: false, sharedSessions: false, plugins: [] },
    ],
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    marketplaces: {},
  }
}

describe('planApply + executeApply', () => {
  it('plans mcp update, new profile dir, hub link, rc block', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(manifest(), await discoverProfiles(home), p)
    const kinds = actions.map(a => a.kind).sort()
    expect(kinds).toEqual(['create-profile-dir', 'link', 'rc-block', 'set-mcp-servers', 'set-mcp-servers'])
  })

  it('executes: surgical json write preserves other keys', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(manifest(), await discoverProfiles(home), p)
    const res = await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    const cfg = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
    expect(cfg.otherKey).toBe('preserve-me')
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
    expect(existsSync(join(home, '.claude-new', '.claude.json'))).toBe(true)
    // windows junctions read back with a \\?\ prefix and may add a trailing separator
    const linkTarget = (await readlink(join(home, '.claude-new', 'skills')))
      .replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
    expect(linkTarget).toBe(join(home, '.claude', 'skills'))
    expect((await readFile(p.rcFile, 'utf8'))).toContain('cl-new')
    expect(res.backupDir).not.toBeNull()
  })

  it('dry run touches nothing', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(manifest(), await discoverProfiles(home), p)
    await executeApply(actions, { backupRoot: join(home, 'b'), stamp: 't2', dryRun: true })
    expect(existsSync(join(home, '.claude-new'))).toBe(false)
  })

  it('is idempotent: second plan is empty', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    await executeApply(planApply(manifest(), await discoverProfiles(home), p),
      { backupRoot: join(home, 'b'), stamp: 't3' })
    expect(planApply(manifest(), await discoverProfiles(home), p)).toEqual([])
  })

  it('migrates existing Codex skills and commands into a Claude hub safely', async () => {
    const codex = join(home, '.codex')
    await mkdir(join(codex, 'skills', 'codex-only'), { recursive: true })
    await mkdir(join(codex, 'prompts'), { recursive: true })
    await writeFile(join(codex, 'config.toml'), '')
    await writeFile(join(codex, 'skills', 'codex-only', 'SKILL.md'), '# codex skill')
    await writeFile(join(codex, 'prompts', 'review.md'), '# review prompt')
    await mkdir(join(home, '.claude', 'skills', 'claude-only'), { recursive: true })
    await mkdir(join(home, '.claude', 'commands'), { recursive: true })
    await writeFile(join(home, '.claude', 'skills', 'claude-only', 'SKILL.md'), '# claude skill')
    await writeFile(join(home, '.claude', 'commands', 'ship.md'), '# ship command')

    const m: Manifest = {
      version: 1, hub: 'default', mcpServers: {}, marketplaces: {},
      profiles: [
        { agent: 'claude', name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, settingsEnv: {}, links: {}, mcp: [], skipPermissions: false, sharedSessions: false, plugins: [] },
        { agent: 'codex', name: 'codex', dir: '{home}/.codex', launcher: 'cx-def', auth: 'oauth', env: {}, settingsEnv: {}, links: { skills: 'hub', commands: 'hub' }, mcp: [], skipPermissions: false, sharedSessions: false, plugins: [] },
      ],
    }
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(m, await discoverProfiles(home), p)
    expect(actions).toContainEqual({ kind: 'link', from: join(codex, 'skills'), to: join(home, '.claude', 'skills') })
    expect(actions).toContainEqual({ kind: 'link', from: join(codex, 'prompts'), to: join(home, '.claude', 'commands') })

    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 'links' })
    expect((await lstat(join(codex, 'skills'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(codex, 'prompts'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'claude-only', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'codex-only', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'commands', 'ship.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'commands', 'review.md'))).toBe(true)
    expect(existsSync(join(home, '.ccprofiles', 'backups', 'links'))).toBe(true)

    const live = await discoverProfiles(home)
    expect(live.find(x => x.agent === 'codex')?.links.commands).toBe(join(home, '.claude', 'commands'))
    expect(planApply(m, live, p)).toEqual([])
  })

  it('rejects a link whose target contains its source', async () => {
    const m = manifest()
    m.profiles[1].links = { skills: '{home}/.claude-new' }
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const live = await discoverProfiles(home)
    expect(() => planApply(m, live, p)).toThrow(/unsafe link topology/)
  })
})

describe('settingsEnv apply', () => {
  const platformFor = (home: string) => detectPlatform({ home, shell: '/bin/zsh' })
  const manifestWith = (settingsEnv: Record<string, string>): Manifest => ({
    version: 1, hub: null, mcpServers: {}, marketplaces: {},
    profiles: [{ name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env', env: {}, links: {}, mcp: [], settingsEnv, skipPermissions: false, sharedSessions: false, plugins: [] }],
  })

  it('resolveSettingsEnv resolves secret refs and passes plain values', async () => {
    const m = manifestWith({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'secret://z-token' })
    const r = await resolveSettingsEnv(m, async n => (n === 'z-token' ? 'tok-123' : null))
    expect(r.z).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok-123' })
  })
  it('resolveSettingsEnv throws on missing secret with exact message', async () => {
    const m = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://nope' })
    await expect(resolveSettingsEnv(m, async () => null))
      .rejects.toThrow('profile "z": secret not found: nope (for ANTHROPIC_AUTH_TOKEN)')
  })
  it('plans and executes set-settings-env, preserving other settings.json keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-apply-senv-'))
    const p = platformFor(home)
    const dir = join(home, '.claude-z')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.claude.json'), '{}')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ model: 'opus', env: { OLD: '1' } }))
    const m = manifestWith({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
    const live = await discoverProfiles(home)
    const resolved = await resolveSettingsEnv(m, async () => null)
    const actions = planApply(m, live, p, resolved)
    expect(actions.some(a => a.kind === 'set-settings-env')).toBe(true)
    await executeApply(actions, { backupRoot: join(home, 'bk'), stamp: 's1' })
    const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(s.model).toBe('opus')
    expect(s.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
    // idempotent: re-plan sees no drift
    const again = planApply(m, await discoverProfiles(home), p, resolved)
    expect(again.filter(a => a.kind === 'set-settings-env')).toEqual([])
  })
  it('empty settingsEnv never touches settings.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-apply-senv2-'))
    const p = platformFor(home)
    const dir = join(home, '.claude-z')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.claude.json'), '{}')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ env: { HAND: 'edited' } }))
    const m = manifestWith({})
    const actions = planApply(m, await discoverProfiles(home), p)
    expect(actions.filter(a => a.kind === 'set-settings-env')).toEqual([])
  })
  it('planApply without resolved map throws if secret refs present', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-apply-senv3-'))
    const m = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://z-token' })
    expect(() => planApply(m, [], platformFor(home))).toThrow(/pass resolved settings env/)
  })
})

describe('shared sessions', () => {
  function sharedManifest(on: boolean): Manifest {
    return {
      version: 1, hub: null,
      profiles: [
        { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, settingsEnv: {},
          links: {}, mcp: [], skipPermissions: false, sharedSessions: on, plugins: [] },
      ],
      mcpServers: {},
      marketplaces: {},
    }
  }

  it('migrates an existing projects dir into the pool and symlinks it', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    // seed a real session under the profile
    await mkdir(join(home, '.claude', 'projects', 'proj'), { recursive: true })
    await writeFile(join(home, '.claude', 'projects', 'proj', 's1.jsonl'), '{"cwd":"/tmp/proj"}\n')

    const actions = planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.map(a => a.kind)).toContain('share-session-dir')
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })

    // projects is now a symlink to the pool
    expect((await lstat(join(home, '.claude', 'projects'))).isSymbolicLink()).toBe(true)
    // the session moved into the pool
    expect(existsSync(join(sharedRoot, 'projects', 'proj', 's1.jsonl'))).toBe(true)
    // a backup was taken
    expect((await readdir(join(home, '.ccprofiles', 'backups'))).length).toBeGreaterThan(0)
  })

  it('is idempotent once symlinked', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    let actions = planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot)
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    actions = planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.some(a => a.kind === 'share-session-dir')).toBe(false)
  })

  it('unshare restores a real dir seeded from the pool without deleting the pool', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    await executeApply(
      planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot),
      { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    await mkdir(join(sharedRoot, 'projects', 'proj'), { recursive: true })
    await writeFile(join(sharedRoot, 'projects', 'proj', 's1.jsonl'), '{"cwd":"/tmp/proj"}\n')

    const actions = planApply(sharedManifest(false), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.map(a => a.kind)).toContain('unshare-session-dir')
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't2' })

    expect((await lstat(join(home, '.claude', 'projects'))).isSymbolicLink()).toBe(false)
    expect(existsSync(join(home, '.claude', 'projects', 'proj', 's1.jsonl'))).toBe(true) // snapshot copied back
    expect(existsSync(join(sharedRoot, 'projects', 'proj', 's1.jsonl'))).toBe(true)      // pool intact
  })

  it('shares and unshares Codex sessions/ with the same migration semantics', async () => {
    const dir = join(home, '.codex-work')
    await mkdir(join(dir, 'sessions', '2026', '07', '10'), { recursive: true })
    await writeFile(join(dir, 'config.toml'), '')
    await writeFile(join(dir, 'sessions', '2026', '07', '10', 'rollout-test.jsonl'), '{"type":"session_meta","payload":{"cwd":"/tmp/proj"}}\n')
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const codexManifest = (on: boolean): Manifest => ({
      version: 1, hub: null, mcpServers: {}, marketplaces: {}, profiles: [{
        agent: 'codex', name: 'codex-work', dir: '{home}/.codex-work', launcher: 'cx-work', auth: 'oauth',
        env: {}, settingsEnv: {}, links: {}, mcp: [], skipPermissions: false, sharedSessions: on, plugins: [],
      }],
    })

    await executeApply(planApply(codexManifest(true), await discoverProfiles(home), p, undefined, sharedRoot),
      { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 'codex-share' })
    expect((await lstat(join(dir, 'sessions'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(sharedRoot, 'sessions', '2026', '07', '10', 'rollout-test.jsonl'))).toBe(true)

    await executeApply(planApply(codexManifest(false), await discoverProfiles(home), p, undefined, sharedRoot),
      { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 'codex-unshare' })
    expect((await lstat(join(dir, 'sessions'))).isSymbolicLink()).toBe(false)
    expect(existsSync(join(dir, 'sessions', '2026', '07', '10', 'rollout-test.jsonl'))).toBe(true)
  })
})
