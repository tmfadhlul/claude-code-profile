import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeAll(async () => {
  // realistic 3-profile fixture mirroring the motivating setup
  home = await mkdtemp(join(tmpdir(), 'ccp-e2e-'))
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await mkdir(join(home, '.claude', 'commands'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, obsidian: { command: 'uvx', args: ['mcp-obsidian'] } },
    oauthAccount: { emailAddress: 'me@personal.com' },
  }))
  await mkdir(join(home, '.claude-office'))
  await writeFile(join(home, '.claude-office', '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    oauthAccount: { emailAddress: 'me@office.co' },
  }))
  await writeFile(join(home, '.zshrc'), 'export ANTHROPIC_API_KEY="sk-ant-api03-LEGACY"\n')
})

describe('e2e: adopt → migrate → mcp sync → apply → doctor', () => {
  it('full pipeline', async () => {
    await run('adopt', '--yes')
    expect(existsSync(join(home, '.ccprofiles', 'manifest.yaml'))).toBe(true)

    await run('secrets', 'migrate')
    expect(await readFile(join(home, '.zshrc'), 'utf8')).not.toContain('sk-ant-api03-LEGACY')

    await run('mcp', 'sync', '--from', 'default', '--to', 'office')
    const office = JSON.parse(await readFile(join(home, '.claude-office', '.claude.json'), 'utf8'))
    expect(Object.keys(office.mcpServers).sort()).toEqual(['obsidian', 'playwright'])

    await run('apply')
    expect(await run('status')).toContain('in sync')

    const doctorOut = await run('doctor')
    expect(doctorOut).toContain('ok')
  })
})
