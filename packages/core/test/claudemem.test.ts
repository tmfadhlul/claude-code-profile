import { describe, it, expect } from 'vitest'
import { pickClaudeMemAuth, renderClaudeMemConfig, claudeMemManagedProfile, CLAUDE_MEM_BEGIN, type ClaudeMemCandidate } from '../src/claudemem.js'

const H = '/h'
const c = (name: string, oauth: boolean, env: Record<string, string> = {}): ClaudeMemCandidate =>
  ({ name, dir: name === 'default' ? `${H}/.claude` : `${H}/.claude-${name}`, oauth, env })

describe('pickClaudeMemAuth', () => {
  it('prefers OAuth over any key, and the default dir among OAuth profiles', () => {
    const a = pickClaudeMemAuth([c('key', false, { ANTHROPIC_API_KEY: 'sk' }), c('aa', true), c('default', true)])
    expect(a).toEqual({ kind: 'oauth', profile: 'default', configDir: `${H}/.claude` })
  })

  it('keeps the OAuth profile already configured', () => {
    expect(pickClaudeMemAuth([c('default', true), c('work', true)], { configDir: `${H}/.claude-work` }))
      .toMatchObject({ profile: 'work' })
  })

  it('does not count an OAuth-logged-in profile that overrides it with a key or gateway', () => {
    const a = pickClaudeMemAuth([c('z', true, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 't' })])
    expect(a?.kind).toBe('gateway')
  })

  it('falls back to a direct API key before a gateway', () => {
    const a = pickClaudeMemAuth([
      c('z', false, { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 't' }),
      c('api', false, { ANTHROPIC_API_KEY: 'sk-ant-x', OTHER: 'y' }),
    ])
    expect(a).toEqual({ kind: 'api-key', profile: 'api', env: { ANTHROPIC_API_KEY: 'sk-ant-x' } })
  })

  it('carries the gateway model so claude-mem does not ask a gateway for a Claude id', () => {
    const a = pickClaudeMemAuth([c('z', false, { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air' })])
    expect(a).toMatchObject({ kind: 'gateway', model: 'glm-4.5-air' })
  })

  it('returns null when nothing can authenticate', () => {
    expect(pickClaudeMemAuth([c('a', false)])).toBeNull()
  })
})

describe('renderClaudeMemConfig', () => {
  const base = { settings: { CLAUDE_MEM_MODEL: 'claude-haiku-4-5', CLAUDE_MEM_PROVIDER: 'claude' }, envText: 'GEMINI_API_KEY=g\n' }

  it('writes a managed .env block for a key profile and keeps foreign lines', () => {
    const r = renderClaudeMemConfig(base, { kind: 'api-key', profile: 'api', env: { ANTHROPIC_API_KEY: 'sk-ant-x' } }, `${H}/.claude`)
    if ('skip' in r) throw new Error('skipped')
    expect(r.envText).toContain('GEMINI_API_KEY=g')
    expect(r.envText).toContain(`${CLAUDE_MEM_BEGIN}\n# profile=api\nANTHROPIC_API_KEY=sk-ant-x\n`)
    expect(r.settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe('api-key')
    expect(claudeMemManagedProfile(r.envText)).toBe('api')
  })

  it('converges: rendering its own output again changes nothing', () => {
    const auth = { kind: 'gateway' as const, profile: 'z', env: { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 't' }, model: 'glm' }
    const r1 = renderClaudeMemConfig(base, auth, `${H}/.claude`)
    if ('skip' in r1) throw new Error('skipped')
    const r2 = renderClaudeMemConfig({ settings: r1.settings, envText: r1.envText }, auth, `${H}/.claude`)
    if ('skip' in r2) throw new Error('skipped')
    expect(r2.changes).toEqual([])
    expect(r2.envText).toBe(r1.envText)
  })

  it('switching gateway → OAuth removes the key and restores the replaced model', () => {
    const gw = renderClaudeMemConfig(base, { kind: 'gateway', profile: 'z', env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw' }, model: 'glm' }, `${H}/.claude`)
    if ('skip' in gw) throw new Error('skipped')
    expect(gw.settings.CLAUDE_MEM_MODEL).toBe('glm')
    const o = renderClaudeMemConfig({ settings: gw.settings, envText: gw.envText }, { kind: 'oauth', profile: 'work', configDir: `${H}/.claude-work` }, `${H}/.claude`)
    if ('skip' in o) throw new Error('skipped')
    expect(o.envText).toBe('GEMINI_API_KEY=g\n')
    expect(o.settings).toMatchObject({ CLAUDE_MEM_MODEL: 'claude-haiku-4-5', CLAUDE_MEM_CLAUDE_CONFIG_DIR: `${H}/.claude-work`, CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' })
  })

  it('leaves a user-chosen provider or hand-written .env keys alone', () => {
    const auth = { kind: 'oauth' as const, profile: 'default', configDir: `${H}/.claude` }
    expect(renderClaudeMemConfig({ settings: { CLAUDE_MEM_PROVIDER: 'gemini' }, envText: '' }, auth, `${H}/.claude`)).toHaveProperty('skip')
    expect(renderClaudeMemConfig({ settings: null, envText: 'export ANTHROPIC_API_KEY=mine\n' }, auth, `${H}/.claude`)).toHaveProperty('skip')
  })

  it('refuses a value .env cannot hold unquoted', () => {
    expect(() => renderClaudeMemConfig(base, { kind: 'api-key', profile: 'a', env: { ANTHROPIC_API_KEY: 'a b' } }, `${H}/.claude`)).toThrow(/cannot hold/)
  })
})
