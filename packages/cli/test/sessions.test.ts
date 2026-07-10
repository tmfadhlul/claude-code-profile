import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-sesscli-'))
  await mkdir(join(home, '.claude', 'projects', 'proj'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'projects', 'proj', 's1.jsonl'), '{"type":"user","cwd":"/tmp/proj","message":{"content":"hi there"}}\n')
})

function run(...args: string[]): Promise<void> {
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any)
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('sessions cli', () => {
  it('share symlinks the profile projects dir into the pool', async () => {
    await run('adopt', '--yes')
    await run('sessions', 'share', 'default')
    expect((await lstat(join(home, '.claude', 'projects'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, '.ccprofiles', 'shared', 'projects', 'proj', 's1.jsonl'))).toBe(true)
  })

  it('list prints the pooled session', async () => {
    await run('adopt', '--yes')
    await run('sessions', 'share', 'default')
    const lines: string[] = []
    const spy = console.log
    console.log = (...a: any[]) => { lines.push(a.join(' ')) }
    try { await run('sessions', 'list') } finally { console.log = spy }
    expect(lines.join('\n')).toContain('/tmp/proj')
    expect(lines.join('\n')).toContain('hi there')
  })

  it('shares Codex sessions and lists a resumable UUID', async () => {
    const codex = join(home, '.codex-work')
    const dated = join(codex, 'sessions', '2026', '07', '10')
    await mkdir(dated, { recursive: true })
    await writeFile(join(codex, 'config.toml'), '')
    await writeFile(join(dated, 'rollout-33333333-3333-4333-8333-333333333333.jsonl'),
      '{"type":"session_meta","payload":{"id":"33333333-3333-4333-8333-333333333333","cwd":"/tmp/codex-project"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex prompt"}]}}\n')
    await run('adopt', '--yes')
    await run('sessions', 'share', 'codex-work')
    expect((await lstat(join(codex, 'sessions'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, '.ccprofiles', 'shared', 'sessions', '2026', '07', '10'))).toBe(true)

    const lines: string[] = []
    const spy = console.log
    console.log = (...a: any[]) => { lines.push(a.join(' ')) }
    try { await run('sessions', 'list') } finally { console.log = spy }
    expect(lines.join('\n')).toContain('[shared/codex] /tmp/codex-project')
    expect(lines.join('\n')).toContain('33333333-3333-4333-8333-333333333333')
  })
})
