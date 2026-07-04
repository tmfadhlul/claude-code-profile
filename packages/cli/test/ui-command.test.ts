import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string, uiDir: string, logs: string[], spy: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uicmd-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  uiDir = await mkdtemp(join(tmpdir(), 'ccp-uicmddir-'))
  await writeFile(join(uiDir, 'index.html'), '<!doctype html>')
  logs = []
  spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
})
afterEach(async () => {
  spy.mockRestore()
  const close = (globalThis as any).__uiServerClose
  ;(globalThis as any).__uiServerClose = undefined
  try { await close?.() } catch { /* not running */ }
})

describe('clp ui', () => {
  it('starts a server and prints a tokened localhost url', async () => {
    const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_UI_DIR: uiDir, SHELL: '/bin/zsh' } as any)
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'ui', '--no-open', '--port', '0'])
    const url = logs.find(l => l.includes('127.0.0.1'))
    expect(url).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)
  })
  it('warns when UI assets are missing', async () => {
    const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_UI_DIR: join(uiDir, 'nope'), SHELL: '/bin/zsh' } as any)
    await buildProgram(ctx).parseAsync(['node', 'ccp', 'ui', '--no-open'])
    expect(logs.join('\n')).toMatch(/assets not found/)
  })
})
