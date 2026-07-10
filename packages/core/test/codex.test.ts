import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { executeApply, planApply } from '../src/apply.js'
import { detectPlatform } from '../src/platform.js'
import { isProjectScopedMcpServer, readCodexMcpServers, writeCodexMcpServers } from '../src/codex.js'
import type { Manifest } from '../src/manifest.js'

describe('Codex apply', () => {
  it('writes MCP servers to config.toml without dropping existing settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-codex-'))
    const dir = join(home, '.codex-work')
    await mkdir(dir)
    await writeFile(join(dir, 'config.toml'), 'model = "gpt-5.4"\n')
    const manifest: Manifest = {
      version: 1, hub: null,
      mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
      profiles: [{ agent: 'codex', name: 'codex-work', dir: '{home}/.codex-work', launcher: 'cx-work', auth: 'oauth', env: {}, links: {}, mcp: ['context7'], settingsEnv: {}, skipPermissions: false, sharedSessions: false, sharedPlugins: false }],
    }
    const platform = detectPlatform({ osKind: 'darwin', home, shell: '/bin/zsh' })
    const actions = planApply(manifest, [], platform)
    await executeApply(actions, { backupRoot: join(home, 'backups'), stamp: 'test' })
    const config = parse(await readFile(join(dir, 'config.toml'), 'utf8')) as any
    expect(config.model).toBe('gpt-5.4')
    expect(config.mcp_servers.context7.command).toBe('npx')
  })
})

describe('Codex user-scope MCP filtering', () => {
  it('isProjectScopedMcpServer flags --project-dir launchers only', () => {
    expect(isProjectScopedMcpServer({ command: 'cce', args: ['serve', '--project-dir', '/x'] })).toBe(true)
    expect(isProjectScopedMcpServer({ command: 'cce', args: ['serve', '--project-dir=/x'] })).toBe(true)
    expect(isProjectScopedMcpServer({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] })).toBe(false)
    expect(isProjectScopedMcpServer({ url: 'https://mcp.example.com' })).toBe(false)
  })

  it('readCodexMcpServers hides project-scoped launchers, keeps user servers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-codex-'))
    const cfg = join(home, 'config.toml')
    await writeFile(cfg, [
      '[mcp_servers.cce-ccprofiles]',
      'command = "cce"',
      'args = [ "serve", "--project-dir", "/proj" ]',
      '',
      '[mcp_servers.composio]',
      'url = "https://connect.composio.dev/mcp"',
    ].join('\n'))
    const servers = await readCodexMcpServers(cfg)
    expect(Object.keys(servers)).toEqual(['composio'])
  })

  it('writeCodexMcpServers preserves an existing project-scoped launcher while updating managed servers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-codex-'))
    const cfg = join(home, 'config.toml')
    await writeFile(cfg, [
      'model = "gpt-5-codex"',
      '',
      '[mcp_servers.cce-ccprofiles]',
      'command = "cce"',
      'args = [ "serve", "--project-dir", "/proj" ]',
    ].join('\n'))
    // clp writes only the user-scope (managed) set it knows about; cce is NOT in it
    await writeCodexMcpServers(cfg, { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio' } })
    const config = parse(await readFile(cfg, 'utf8')) as any
    expect(config.model).toBe('gpt-5-codex')                 // unrelated settings preserved
    expect(config.mcp_servers['cce-ccprofiles'].command).toBe('cce') // project launcher NOT deleted
    expect(config.mcp_servers.context7.command).toBe('npx')  // managed server written
    expect(config.mcp_servers.context7.type).toBeUndefined() // claude transport type stripped
    // and the preserved launcher stays hidden from clp on re-read
    expect(Object.keys(await readCodexMcpServers(cfg))).toEqual(['context7'])
  })
})
