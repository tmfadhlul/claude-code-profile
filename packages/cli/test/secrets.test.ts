import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'
import { envKeyLine, secretRef, seedRc } from './helpers.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'test-pw', SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-sec-')) })

describe('ccprofiles secrets', () => {
  it('set/get/list/rm round-trip', async () => {
    await run('secrets', 'set', 'api-key', 'sk-ant-xyz')
    expect(await run('secrets', 'get', 'api-key')).toBe('sk-ant-xyz')
    expect(await run('secrets', 'list')).toContain('api-key')
    await run('secrets', 'rm', 'api-key')
    expect(await run('secrets', 'list')).not.toContain('api-key')
  })
  it('migrate moves plaintext keys out of rc', async () => {
    const rc = await seedRc(home, envKeyLine('ANTHROPIC_API_KEY', 'sk-ant-api03-SECRET') + '\n# keep me\n')
    const out = await run('secrets', 'migrate')
    expect(out).toContain('anthropic-api-key')
    const after = await readFile(rc, 'utf8')
    expect(after).not.toContain('sk-ant-api03-SECRET')
    expect(after).toContain(secretRef('anthropic-api-key'))
    expect(after).toContain('# keep me')
    expect(await run('secrets', 'get', 'anthropic-api-key')).toBe('sk-ant-api03-SECRET')
  })
})
