import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readlink } from 'node:fs/promises'
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
        links: {}, mcp: ['playwright'], skipPermissions: false, sharedSessions: false },
      { name: 'new', dir: '{home}/.claude-new', launcher: 'cl-new', auth: 'env', env: {}, settingsEnv: {},
        links: { skills: 'hub' }, mcp: ['playwright'], skipPermissions: false, sharedSessions: false },
    ],
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
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
})

describe('settingsEnv apply', () => {
  const platformFor = (home: string) => detectPlatform({ home, shell: '/bin/zsh' })
  const manifestWith = (settingsEnv: Record<string, string>): Manifest => ({
    version: 1, hub: null, mcpServers: {},
    profiles: [{ name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env', env: {}, links: {}, mcp: [], settingsEnv, skipPermissions: false, sharedSessions: false }],
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
