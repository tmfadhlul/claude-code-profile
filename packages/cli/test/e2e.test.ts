import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'
import { envKeyLine, rcFileFor, seedRc } from './helpers.js'

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
  await seedRc(home, envKeyLine('ANTHROPIC_API_KEY', 'sk-ant-api03-LEGACY') + '\n')
})

describe('e2e: adopt → migrate → mcp sync → apply → doctor', () => {
  it('full pipeline', async () => {
    await run('adopt', '--yes')
    expect(existsSync(join(home, '.ccprofiles', 'manifest.yaml'))).toBe(true)

    await run('secrets', 'migrate')
    expect(await readFile(rcFileFor(home), 'utf8')).not.toContain('sk-ant-api03-LEGACY')

    await run('mcp', 'sync', '--from', 'default', '--to', 'office')
    const office = JSON.parse(await readFile(join(home, '.claude-office', '.claude.json'), 'utf8'))
    expect(Object.keys(office.mcpServers).sort()).toEqual(['obsidian', 'playwright'])

    await run('apply')
    expect(await run('status')).toContain('in sync')

    const doctorOut = await run('doctor')
    expect(doctorOut).toContain('ok')
  })
})

describe('doctor: warns on a configured git remote in ~/.ccprofiles', () => {
  it('flags a remote once one is added', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'ccp-e2e-remote-'))
    await mkdir(join(remoteHome, '.claude'))
    await writeFile(join(remoteHome, '.claude.json'), JSON.stringify({
      mcpServers: {}, oauthAccount: { emailAddress: 'me@personal.com' },
    }))
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
    const ctx = makeContext({ CCPROFILES_TEST_HOME: remoteHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'adopt', '--yes'])
    execFileSync('git', ['-C', ctx.manifestRoot, 'remote', 'add', 'origin', 'https://example.com/x.git'])
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'doctor'])
    spy.mockRestore()
    expect(lines.join('\n')).toMatch(/git remote configured/)
  })
})

describe('doctor: rc-file plaintext-key warning always agrees with `secrets migrate`', () => {
  it('does not warn about a key `secrets migrate` cannot actually fix', async () => {
    // Previously doctor used a separate, looser /sk-ant-/ substring check while `secrets
    // migrate` only rewrites `export KEY_VARS_NAME=sk-...` lines it recognizes — so a comment
    // or an export under an unsupported variable name made doctor say "run secrets migrate"
    // while migrate replied "no plaintext keys found", with no way out for the user.
    const rcHome = await mkdtemp(join(tmpdir(), 'ccp-doctor-rc-'))
    await mkdir(join(rcHome, '.claude'))
    await writeFile(join(rcHome, '.claude.json'), JSON.stringify({ mcpServers: {}, oauthAccount: { emailAddress: 'me@personal.com' } }))
    await seedRc(rcHome, [
      '# reminder: my old key used to be sk-ant-api03-RETIRED, rotated already',
      'export SOME_OTHER_TOOL_KEY="sk-ant-api03-NOTOURS"',
      '',
    ].join('\n'))
    const ctx = makeContext({ CCPROFILES_TEST_HOME: rcHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'adopt', '--yes'])

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'doctor'])
    spy.mockRestore()
    expect(lines.join('\n')).not.toMatch(/plaintext key/)

    // and secrets migrate genuinely has nothing to do here, matching doctor's silence
    const migrateLines: string[] = []
    const migrateSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { migrateLines.push(a.join(' ')) })
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'secrets', 'migrate'])
    migrateSpy.mockRestore()
    expect(migrateLines.join('\n')).toMatch(/no plaintext keys found/)
  })

  it('warns about, and secrets migrate fixes, a genuinely migratable key', async () => {
    const rcHome = await mkdtemp(join(tmpdir(), 'ccp-doctor-rc-fix-'))
    await mkdir(join(rcHome, '.claude'))
    await writeFile(join(rcHome, '.claude.json'), JSON.stringify({ mcpServers: {}, oauthAccount: { emailAddress: 'me@personal.com' } }))
    await seedRc(rcHome, envKeyLine('ANTHROPIC_API_KEY', 'sk-ant-api03-REAL') + '\n')
    const ctx = makeContext({ CCPROFILES_TEST_HOME: rcHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'adopt', '--yes'])

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'doctor'])
    spy.mockRestore()
    expect(lines.join('\n')).toMatch(/plaintext key.*anthropic-api-key.*run: ccprofiles secrets migrate/)

    await buildProgram(ctx).parseAsync(['node', 'ccp', 'secrets', 'migrate'])
    expect(await readFile(rcFileFor(rcHome), 'utf8')).not.toContain('sk-ant-api03-REAL')
  })
})
