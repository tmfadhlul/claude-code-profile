import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest } from '../src/adopt.js'
import { detectPlatform } from '../src/platform.js'
import { discoverProfiles, type LiveProfile } from '../src/discovery.js'

const p = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const live: LiveProfile[] = [
  { dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
    account: 'a@b.c', links: {}, settingsEnv: {},
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
  { dirName: '.claude-oauth', dir: '/Users/x/.claude-oauth', configPath: '/Users/x/.claude-oauth/.claude.json',
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
