import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  home = await mkdtemp(join(tmpdir(), 'ccp-cli-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
})

describe('ccprofiles list', () => {
  it('shows discovered profiles', async () => {
    const out = await run('list')
    expect(out).toContain('default')
    expect(out).toContain('a@b.c')
  })
})

describe('ccprofiles adopt', () => {
  it('writes manifest with --yes', async () => {
    await run('adopt', '--yes')
    expect(existsSync(join(home, '.ccprofiles', 'manifest.yaml'))).toBe(true)
  })
})

describe('ccprofiles --version', () => {
  it('prints the cli package version', async () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string }

    const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any)
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { chunks.push(String(chunk)); return true })
    try {
      await expect(buildProgram(ctx).parseAsync(['node', 'ccp', '--version'])).rejects.toMatchObject({ code: 'commander.version' })
    } finally {
      spy.mockRestore()
    }
    expect(chunks.join('')).toContain(pkg.version)
  })
})
