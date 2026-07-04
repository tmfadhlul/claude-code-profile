import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-mcp-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  await mkdir(join(home, '.claude-work'))
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await run('adopt', '--yes')
})

describe('ccprofiles mcp', () => {
  it('list shows drift matrix', async () => {
    const out = await run('mcp', 'list')
    expect(out).toContain('playwright')
    expect(out).toMatch(/x/)
    expect(out).toMatch(/\./)
  })
  it('add to all profiles updates live configs', async () => {
    await run('mcp', 'add', 'shadcn', '--all', '--command', 'npx', '--args', 'shadcn@latest,mcp')
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(cfg.mcpServers.shadcn.args).toEqual(['shadcn@latest', 'mcp'])
  })
  it('sync copies mcp set between profiles', async () => {
    await run('mcp', 'sync', '--from', 'default', '--to', 'work')
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
  })
  it('rm drops def when unreferenced', async () => {
    await run('mcp', 'rm', 'playwright', '--all')
    const manifest = await readFile(join(home, '.ccprofiles', 'manifest.yaml'), 'utf8')
    expect(manifest).not.toContain('playwright')
  })
})
