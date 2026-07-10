import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAssets, writeAssets } from '../src/assets.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-assets-')) })

function codexHub(): Manifest {
  return {
    version: 1, hub: 'codex', mcpServers: {},
    profiles: [{
      agent: 'codex', name: 'codex', dir: '{home}/.codex', launcher: null, auth: 'oauth',
      env: {}, settingsEnv: {}, links: {}, mcp: [], skipPermissions: false, sharedSessions: false, sharedPlugins: false,
    }],
  }
}

describe('cross-agent shared assets', () => {
  it('serializes Codex prompts as logical commands and restores them to prompts/', async () => {
    await mkdir(join(home, '.codex', 'prompts'), { recursive: true })
    await mkdir(join(home, '.codex', 'skills', 'review'), { recursive: true })
    await writeFile(join(home, '.codex', 'prompts', 'ship.md'), '# ship')
    await writeFile(join(home, '.codex', 'skills', 'review', 'SKILL.md'), '# review')
    const platform = detectPlatform({ home, shell: '/bin/zsh' })
    const assets = await collectAssets(codexHub(), platform)
    expect(assets['hub/commands/ship.md']).toBe('# ship')
    expect(assets['hub/skills/review/SKILL.md']).toBe('# review')

    const targetHome = await mkdtemp(join(tmpdir(), 'ccp-assets-target-'))
    const targetPlatform = detectPlatform({ home: targetHome, shell: '/bin/zsh' })
    await writeAssets(assets, codexHub(), targetPlatform)
    expect(await readFile(join(targetHome, '.codex', 'prompts', 'ship.md'), 'utf8')).toBe('# ship')
    expect(await readFile(join(targetHome, '.codex', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('# review')
  })

  it.each(['hub/skills/../../outside', 'hub\\skills\\outside', 'profiles/codex/../AGENTS.md', 'unknown/file'])(
    'rejects unsafe imported asset path %j',
    async rel => {
      const platform = detectPlatform({ home, shell: '/bin/zsh' })
      await expect(writeAssets({ [rel]: 'owned' }, codexHub(), platform)).rejects.toThrow(/unsafe asset path/)
    },
  )

  it('refuses to write imported assets through a symlinked directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ccp-assets-outside-'))
    await mkdir(join(home, '.codex'), { recursive: true })
    await symlink(outside, join(home, '.codex', 'skills'))
    const platform = detectPlatform({ home, shell: '/bin/zsh' })
    await expect(writeAssets({ 'hub/skills/owned/SKILL.md': 'owned' }, codexHub(), platform))
      .rejects.toThrow(/through symlink/)
  })
})
