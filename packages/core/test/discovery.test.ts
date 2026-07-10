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
  it('discovers Codex homes and reads TOML MCP servers', async () => {
    const home4 = await mkdtemp(join(tmpdir(), 'ccp-disc-codex-'))
    await mkdir(join(home4, '.codex-work'), { recursive: true })
    await writeFile(join(home4, '.codex-work', 'config.toml'), `model = "gpt-5.4"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n`)
    await writeFile(join(home4, '.codex-work', 'auth.json'), '{}')
    const live = await discoverProfiles(home4)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ agent: 'codex', dirName: '.codex-work', authenticated: true })
    expect(live[0].mcpServers.context7).toMatchObject({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] })
  })
})
