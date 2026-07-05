import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProfiles } from '../src/discovery.js'

let home: string
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-home-'))
  // default profile: dir .claude + config at ~/.claude.json
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    oauthAccount: { emailAddress: 'a@b.c' },
  }))
  // named profile with symlinked skills
  await mkdir(join(home, '.claude-oauth'))
  await writeFile(join(home, '.claude-oauth', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await symlink(join(home, '.claude', 'skills'), join(home, '.claude-oauth', 'skills'))
  // non-profile dir
  await mkdir(join(home, '.claude-mem'))
})

describe('discoverProfiles', () => {
  it('finds profiles, skips non-profiles', async () => {
    const found = await discoverProfiles(home)
    expect(found.map(p => p.dirName).sort()).toEqual(['.claude', '.claude-oauth'])
  })
  it('reads account and mcpServers from default profile config in home', async () => {
    const def = (await discoverProfiles(home)).find(p => p.dirName === '.claude')!
    expect(def.account).toBe('a@b.c')
    expect(Object.keys(def.mcpServers)).toEqual(['playwright'])
  })
  it('captures symlinks', async () => {
    const oauth = (await discoverProfiles(home)).find(p => p.dirName === '.claude-oauth')!
    expect(oauth.links.skills).toBe(join(home, '.claude', 'skills'))
  })
  it('reads settingsEnv from settings.json, skipping non-strings', async () => {
    const home2 = await mkdtemp(join(tmpdir(), 'ccp-disc-senv-'))
    await mkdir(join(home2, '.claude-z'), { recursive: true })
    await writeFile(join(home2, '.claude-z', '.claude.json'), '{}')
    await writeFile(join(home2, '.claude-z', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', NUM: 42 },
      model: 'opus',
    }))
    const live = await discoverProfiles(home2)
    const z = live.find(l => l.dirName === '.claude-z')!
    expect(z.settingsEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
  })
  it('settingsEnv is {} when settings.json is absent or invalid', async () => {
    const home3 = await mkdtemp(join(tmpdir(), 'ccp-disc-senv2-'))
    await mkdir(join(home3, '.claude'), { recursive: true })
    await writeFile(join(home3, '.claude.json'), '{}')
    const live = await discoverProfiles(home3)
    expect(live[0].settingsEnv).toEqual({})
  })
})
