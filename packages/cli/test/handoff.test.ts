import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-handoff-'))
  // source: a claude profile 'a'
  await mkdir(join(home, '.claude-a'), { recursive: true })
  await writeFile(join(home, '.claude-a', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  // target: a codex profile -> name 'codex-b'
  await mkdir(join(home, '.codex-b'), { recursive: true })
  await writeFile(join(home, '.codex-b', 'config.toml'), 'model = "gpt-5-codex"\n')
  await writeFile(join(home, '.codex-b', 'auth.json'), '{"tokens":{}}')
})

function run(...args: string[]): Promise<void> {
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('handoff cli', () => {
  it('--print writes a transcript file and prints a launch targeting the other agent', async () => {
    await run('adopt', '--yes')
    // seed a claude session for profile 'a' whose recorded cwd == this test's cwd
    const pdir = join(home, '.claude-a', 'projects', 'proj')
    await mkdir(pdir, { recursive: true })
    await writeFile(join(pdir, 'sess-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: process.cwd(), message: { content: 'prior work here' } }) + '\n')

    const lines: string[] = []
    const spy = console.log
    console.log = (...a: any[]) => { lines.push(a.join(' ')) }
    try { await run('handoff', '--from', 'a', '--to', 'codex-b', '--print') } finally { console.log = spy }

    const out = lines.join('\n')
    const fileLine = lines.find(l => l.startsWith('handoff file: '))!
    const file = fileLine.replace('handoff file: ', '').trim()
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('prior work here')
    expect(out).toContain('command: codex')
    expect(out).toContain(`CODEX_HOME=${join(home, '.codex-b')}`)
    expect(out).toContain('Read it, then pick up where it left off')
  })

  it('errors when there is no session for this project', async () => {
    await run('adopt', '--yes')
    await expect(run('handoff', '--from', 'a', '--to', 'codex-b', '--print')).rejects.toThrow(/no a session/)
  })

  it('rejects handoff to the same profile', async () => {
    await run('adopt', '--yes')
    await expect(run('handoff', '--from', 'a', '--to', 'a', '--print')).rejects.toThrow(/same profile/)
  })
})
