import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
  home = await mkdtemp(join(tmpdir(), 'ccp-man-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  await run('adopt', '--yes')
  await run('apply')
})

describe('status/apply/create', () => {
  it('status reports in sync after apply', async () => {
    expect(await run('status')).toContain('in sync')
  })
  it('create scaffolds a new profile and launcher', async () => {
    await run('create', 'work', '--from', 'default')
    expect(existsSync(join(home, '.claude-work', '.claude.json'))).toBe(true)
    const rc = await readFile(join(home, '.zshrc'), 'utf8')
    expect(rc).toContain('cl-work()')
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
  })
})
