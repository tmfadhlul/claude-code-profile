import { describe, it, expect } from 'vitest'
import { buildManifest } from '../src/adopt.js'
import { detectPlatform } from '../src/platform.js'
import type { LiveProfile } from '../src/discovery.js'

const p = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const live: LiveProfile[] = [
  { dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
    account: 'a@b.c', links: {},
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
  { dirName: '.claude-oauth', dir: '/Users/x/.claude-oauth', configPath: '/Users/x/.claude-oauth/.claude.json',
    account: 'a@b.c', links: { skills: '/Users/x/.claude/skills' },
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
})
