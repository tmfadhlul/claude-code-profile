import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { executeApply, planApply } from '../src/apply.js'
import { detectPlatform } from '../src/platform.js'
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
      profiles: [{ agent: 'codex', name: 'codex-work', dir: '{home}/.codex-work', launcher: 'cx-work', auth: 'oauth', env: {}, links: {}, mcp: ['context7'], settingsEnv: {}, skipPermissions: false, sharedSessions: false }],
    }
    const platform = detectPlatform({ osKind: 'darwin', home, shell: '/bin/zsh' })
    const actions = planApply(manifest, [], platform)
    await executeApply(actions, { backupRoot: join(home, 'backups'), stamp: 'test' })
    const config = parse(await readFile(join(dir, 'config.toml'), 'utf8')) as any
    expect(config.model).toBe('gpt-5.4')
    expect(config.mcp_servers.context7.command).toBe('npx')
  })
})
