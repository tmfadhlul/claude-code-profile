import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<{ out: string; err: Error | null }> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any)
  let err: Error | null = null
  try { await buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) } catch (e) { err = e as Error }
  spy.mockRestore()
  return { out: lines.join('\n'), err }
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-firstrun-')) })

// every manifest-requiring command must guide the user to adopt, not dump ENOENT
const CASES: string[][] = [
  ['mcp', 'list'],
  ['status'],
  ['apply'],
  ['export', '/tmp/ccp-firstrun-never-written.ccb'],
  ['create', 'work'],
  ['mcp', 'add', 'x', '--all', '--command', 'npx'],
  ['mcp', 'rm', 'x', '--all'],
  ['mcp', 'sync', '--from', 'a', '--to', 'b'],
]

describe('first run without a manifest', () => {
  for (const args of CASES) {
    it(`ccprofiles ${args.join(' ')} points to adopt`, async () => {
      const { err } = await run(...args)
      expect(err).not.toBeNull()
      expect(err!.message).toMatch(/no manifest yet.*ccprofiles adopt --yes/s)
      expect(err!.message).not.toMatch(/ENOENT/)
    })
  }
})
