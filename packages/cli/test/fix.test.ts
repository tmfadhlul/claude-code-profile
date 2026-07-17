import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'
import type { PluginRunner } from 'ccprofiles-core'

let home: string, calls: string[], ctx: any
function fake(): PluginRunner {
  return {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
    update: async (_d, id) => { calls.push(`update ${id}`) },
  }
}
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}
/** Give a profile an installed_plugins.json holding claude-mem at `version`. */
async function seedClaudeMem(dir: string, version: string): Promise<void> {
  await mkdir(join(home, dir, 'plugins'), { recursive: true })
  const cfg = dir === '.claude' ? join(home, '.claude.json') : join(home, dir, '.claude.json')
  await writeFile(cfg, JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, dir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', version }] } }))
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-fix-')); calls = []
  ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any), pluginRunner: fake() }
})

describe('ccprofiles fix', () => {
  it('resolves plugin version drift by updating every profile that holds the drifted plugin', async () => {
    await seedClaudeMem('.claude', '13.10.4')
    await seedClaudeMem('.claude-work', '13.11.0')
    const out = await run('fix')
    // both hold the plugin, so both are re-leveled to latest (the one already ahead no-ops)
    expect(calls.filter(c => c === 'update claude-mem@thedotmack').length).toBe(2)
    expect(out).toMatch(/cleared 2 finding/)
  })

  it('says nothing to fix when every profile agrees', async () => {
    await seedClaudeMem('.claude', '13.11.0')
    await seedClaudeMem('.claude-work', '13.11.0')
    const out = await run('fix')
    expect(calls).toEqual([])
    expect(out).toMatch(/nothing to fix/)
  })
})
