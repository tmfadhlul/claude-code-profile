import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planApply, executeApply } from '../src/apply.js'
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
      { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {},
        links: {}, mcp: ['playwright'] },
      { name: 'new', dir: '{home}/.claude-new', launcher: 'cl-new', auth: 'env', env: {},
        links: { skills: 'hub' }, mcp: ['playwright'] },
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
