import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProfiles } from '../src/discovery.js'
import { planPluginVersionDrift } from '../src/plugins.js'

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
  it('reads enabledPlugins from a profile settings.json', async () => {
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-plugins-'))
    await mkdir(join(h, '.claude-x'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    await writeFile(join(h, '.claude-x', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true, 'off@m': false } }))
    const live = await discoverProfiles(h)
    const x = live.find(p => p.dirName === '.claude-x')!
    expect(x.enabledPlugins).toEqual({ 'ponytail@ponytail': true, 'off@m': false })
  })
  it('reads marketplaces from known_marketplaces.json', async () => {
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-mkt-'))
    await mkdir(join(h, '.claude-x', 'plugins'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    await writeFile(join(h, '.claude-x', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } } }))
    const live = await discoverProfiles(h)
    const x = live.find(p => p.dirName === '.claude-x')!
    expect(x.marketplaces).toEqual({ ponytail: { source: 'DietrichGebert/ponytail' } })
  })
  it('reads installed plugin ids from installed_plugins.json (enabled-but-not-installed stays out)', async () => {
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-inst-'))
    await mkdir(join(h, '.claude-x', 'plugins'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    // enabledPlugins claims two plugins, but only one is actually installed
    await writeFile(join(h, '.claude-x', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true, 'ghost@mkt': true } }))
    await writeFile(join(h, '.claude-x', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user' }] } }))
    const live = await discoverProfiles(h)
    const x = live.find(p => p.dirName === '.claude-x')!
    expect(x.installedPlugins).toEqual(['ponytail@ponytail'])
  })
  it('ignores project-scope installs — `claude plugin update` only acts on user scope', async () => {
    // real incident: a profile held every plugin at scope 'project'; drift-fix then ran
    // `claude plugin update` there and got `Plugin "context7" is not installed at scope user`.
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-scope-'))
    await mkdir(join(h, '.claude-x', 'plugins'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    await writeFile(join(h, '.claude-x', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'proj@mkt': [{ scope: 'project', projectPath: '/tmp/p', version: '1.0.0' }],
        'both@mkt': [{ scope: 'project', version: '1.0.0' }, { scope: 'user', version: '2.0.0' }],
        'legacy@mkt': [{ version: '3.0.0' }], // pre-`scope` entry: treated as user
      },
    }))
    const x = (await discoverProfiles(h)).find(p => p.dirName === '.claude-x')!
    expect(x.installedPlugins).toEqual(['both@mkt', 'legacy@mkt'])
    expect(x.installedPluginVersions).toEqual({ 'both@mkt': '2.0.0', 'legacy@mkt': '3.0.0' })
  })

  it('reads installed plugin versions, ignoring versionless plugins entirely', async () => {
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-ver-'))
    await mkdir(join(h, '.claude-x', 'plugins'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    await writeFile(join(h, '.claude-x', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'claude-mem@thedotmack': [{ scope: 'user', version: '13.11.0', gitCommitSha: 'f5633c1f8418' }],
        'context7@claude-plugins-official': [{ scope: 'user', version: 'unknown', gitCommitSha: 'e14e8fe2c1fc' }],
        'noversion@mkt': [{ scope: 'user' }],
      },
    }))
    const x = (await discoverProfiles(h)).find(p => p.dirName === '.claude-x')!
    // only the released plugin is comparable; the sha is NOT a usable identity (see the fn's doc)
    expect(x.installedPluginVersions).toEqual({ 'claude-mem@thedotmack': '13.11.0' })
    // both versionless plugins are still installed — just nothing to compare on
    expect(x.installedPlugins).toEqual(expect.arrayContaining(['context7@claude-plugins-official', 'noversion@mkt']))
  })

  it('reports no drift for a versionless plugin whose shas differ across profiles', async () => {
    // The 2026-07-20 incident: identical context7 files in every profile, but different install-time
    // marketplace shas. Comparing those shas warned of drift that `clp fix` could never clear —
    // `claude plugin update` correctly no-ops, so the stale sha never moves.
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-sha-'))
    for (const [dir, sha] of [['.claude-a', '205b6e0b3036'], ['.claude-b', 'e14e8fe2c1fc']] as const) {
      await mkdir(join(h, dir, 'plugins'), { recursive: true })
      await writeFile(join(h, dir, '.claude.json'), '{}')
      await writeFile(join(h, dir, 'plugins', 'installed_plugins.json'), JSON.stringify({
        version: 2, plugins: { 'context7@claude-plugins-official': [{ scope: 'user', version: 'unknown', gitCommitSha: sha }] },
      }))
    }
    const live = await discoverProfiles(h)
    expect(planPluginVersionDrift(live.map(p => ({ name: p.dirName, versions: p.installedPluginVersions })))).toEqual([])
  })

  it('keeps a real release version rather than its sha', async () => {
    // the guard above must not swallow '13.11.0' just because a gitCommitSha sits next to it
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-rel-'))
    await mkdir(join(h, '.claude-a', 'plugins'), { recursive: true })
    await writeFile(join(h, '.claude-a', '.claude.json'), '{}')
    await writeFile(join(h, '.claude-a', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', version: '13.11.0', gitCommitSha: 'f5633c1f84181673896c038cbe285131c6d669a3' }] },
    }))
    const x = (await discoverProfiles(h)).find(p => p.dirName === '.claude-a')!
    expect(x.installedPluginVersions['claude-mem@thedotmack']).toBe('13.11.0')
  })
  it('installedPluginVersions is empty when installed_plugins.json is absent', async () => {
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-nover-'))
    await mkdir(join(h, '.claude-x'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    const live = await discoverProfiles(h)
    expect(live.find(p => p.dirName === '.claude-x')!.installedPluginVersions).toEqual({})
  })
  it('installedPlugins is empty when installed_plugins.json is absent', async () => {
    const h = await mkdtemp(join(tmpdir(), 'ccp-disc-noinst-'))
    await mkdir(join(h, '.claude-x'), { recursive: true })
    await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
    const live = await discoverProfiles(h)
    expect(live.find(p => p.dirName === '.claude-x')!.installedPlugins).toEqual([])
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
