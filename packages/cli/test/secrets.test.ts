import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext, type CliContext } from '../src/context.js'
import { envKeyLine, secretRef, seedRc } from './helpers.js'

let home: string
async function run(args: string[], ctxOverrides: Partial<CliContext> = {}): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'test-pw', SHELL: '/bin/zsh' } as any), ...ctxOverrides }
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-sec-')) })

describe('ccprofiles secrets', () => {
  it('set/get/list/rm round-trip', async () => {
    await run(['secrets', 'set', 'api-key', 'sk-ant-xyz'])
    expect(await run(['secrets', 'get', 'api-key'])).toBe('sk-ant-xyz')
    expect(await run(['secrets', 'list'])).toContain('api-key')
    await run(['secrets', 'rm', 'api-key'])
    expect(await run(['secrets', 'list'])).not.toContain('api-key')
  })
  it('migrate moves plaintext keys out of rc', async () => {
    const rc = await seedRc(home, envKeyLine('ANTHROPIC_API_KEY', 'sk-ant-api03-SECRET') + '\n# keep me\n')
    const out = await run(['secrets', 'migrate'])
    expect(out).toContain('anthropic-api-key')
    const after = await readFile(rc, 'utf8')
    expect(after).not.toContain('sk-ant-api03-SECRET')
    expect(after).toContain(secretRef('anthropic-api-key'))
    expect(after).toContain('# keep me')
    expect(await run(['secrets', 'get', 'anthropic-api-key'])).toBe('sk-ant-api03-SECRET')
  })

  it('set with no value prompts via the injected masked reader and stores the entered value', async () => {
    const seen: string[] = []
    const promptSecret = vi.fn(async (label: string) => { seen.push(label); return 'sk-ant-from-prompt' })
    await run(['secrets', 'set', 'api-key'], { promptSecret })
    expect(promptSecret).toHaveBeenCalledTimes(1)
    expect(seen[0]).toContain('api-key')
    expect(await run(['secrets', 'get', 'api-key'])).toBe('sk-ant-from-prompt')
  })

  it('set with an explicit value still stores it but warns on stderr about shell history', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await run(['secrets', 'set', 'api-key', 'sk-ant-argv'])
    expect(errSpy).toHaveBeenCalled()
    const warning = errSpy.mock.calls.map(c => String(c[0])).join('')
    errSpy.mockRestore()
    expect(warning).toMatch(/shell history/i)
    expect(await run(['secrets', 'get', 'api-key'])).toBe('sk-ant-argv')
  })
})
