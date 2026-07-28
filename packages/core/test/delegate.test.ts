import { describe, it, expect } from 'vitest'
import { buildDelegateLaunch, delegateEnv, PROVIDER_ENV_KEYS } from '../src/delegate.js'

const base = {
  targetDir: '/home/u/.claude-kimi',
  targetEnv: {},
  skipPermissions: true,
  prompt: 'build the settings panel',
  cwd: '/repo',
}

describe('delegateEnv', () => {
  it('strips every provider pin from the calling session', () => {
    const parent = {
      PATH: '/usr/bin', HOME: '/home/u',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-z',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'z-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
    }
    const env = delegateEnv(parent, 'CLAUDE_CONFIG_DIR', '/home/u/.claude-oauth', {})
    // the z gateway must not follow us into an oauth delegate, or it authenticates as one
    // account and sends the traffic to the other provider
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-oauth')
    expect(env.PATH).toBe('/usr/bin') // unrelated env still inherited
  })

  it("re-applies the target's own provider env after the strip", () => {
    const parent = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
    const env = delegateEnv(parent, 'CLAUDE_CONFIG_DIR', '/home/u/.claude-kimi',
      { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' })
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/')
  })

  it('drops undefined parent values instead of stringifying them', () => {
    expect(delegateEnv({ NOPE: undefined }, 'CODEX_HOME', '/d', {})).not.toHaveProperty('NOPE')
  })

  it('covers both agents\' home vars in the strip list', () => {
    expect(PROVIDER_ENV_KEYS).toContain('CLAUDE_CONFIG_DIR')
    expect(PROVIDER_ENV_KEYS).toContain('CODEX_HOME')
  })
})

describe('buildDelegateLaunch', () => {
  it('builds a headless claude invocation with the prompt last', () => {
    const l = buildDelegateLaunch({ ...base, targetAgent: 'claude', model: 'opus' })
    expect(l.command).toBe('claude')
    expect(l.args).toEqual(['-p', '--model', 'opus', '--dangerously-skip-permissions', 'build the settings panel'])
    expect(l.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-kimi')
    expect(l.cwd).toBe('/repo')
  })

  it('omits the skip flag when permissions are not waived', () => {
    const l = buildDelegateLaunch({ ...base, targetAgent: 'claude', skipPermissions: false })
    expect(l.args).not.toContain('--dangerously-skip-permissions')
  })

  it('adds --output-format json only for claude', () => {
    expect(buildDelegateLaunch({ ...base, targetAgent: 'claude', json: true }).args)
      .toEqual(expect.arrayContaining(['--output-format', 'json']))
    expect(buildDelegateLaunch({ ...base, targetAgent: 'codex', json: true }).args)
      .not.toContain('--output-format')
  })

  it('uses codex exec with -C for the workspace, since spawn cwd alone does not set it', () => {
    const l = buildDelegateLaunch({ ...base, targetAgent: 'codex', targetDir: '/home/u/.codex', model: 'gpt-5' })
    expect(l.command).toBe('codex')
    expect(l.args).toEqual([
      'exec', '-m', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox', '-C', '/repo',
      'build the settings panel',
    ])
    expect(l.env.CODEX_HOME).toBe('/home/u/.codex')
    expect(l.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('keeps a prompt that looks like a flag as a positional, not an option', () => {
    const l = buildDelegateLaunch({ ...base, targetAgent: 'claude', prompt: '--help me refactor' })
    expect(l.args[l.args.length - 1]).toBe('--help me refactor')
  })
})
