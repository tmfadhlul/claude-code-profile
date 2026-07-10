import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-plugins-'))
  await mkdir(join(home, '.claude', 'plugins', 'cache', 'ponytail'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
})

function run(...args: string[]): Promise<void> {
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('plugins cli', () => {
  it('share links the profile plugins dir into the pool and unions enabled plugins', async () => {
    await run('adopt', '--yes')
    await run('plugins', 'share', 'default')
    expect((await lstat(join(home, '.claude', 'plugins'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, '.ccprofiles', 'shared', 'plugins', 'cache', 'ponytail'))).toBe(true)
    const cfg = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(cfg.enabledPlugins['ponytail@ponytail']).toBe(true)
  })
})
