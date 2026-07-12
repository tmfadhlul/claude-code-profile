import { describe, it, expect } from 'vitest'
import { anthropicAuthMode, setAnthropicAuthMode } from '../src/provider.js'

describe('anthropicAuthMode', () => {
  it('derives the mode from settingsEnv', () => {
    expect(anthropicAuthMode({})).toBe('login')
    expect(anthropicAuthMode({ ANTHROPIC_API_KEY: 'secret://k' })).toBe('api-key')
    expect(anthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: 'secret://t' })).toBe('auth-token')
    // both present (hand-edited) → prefer api-key
    expect(anthropicAuthMode({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b' })).toBe('api-key')
  })
})

describe('setAnthropicAuthMode', () => {
  it('login clears both token vars, keeps other keys', () => {
    const out = setAnthropicAuthMode({ ANTHROPIC_API_KEY: 'secret://k', ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' }, 'login')
    expect(out).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' })
  })
  it('api-key sets the key, removes auth-token, keeps other keys', () => {
    const out = setAnthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: 'secret://t', API_TIMEOUT_MS: '30000' }, 'api-key', 'secret://mykey')
    expect(out).toEqual({ ANTHROPIC_API_KEY: 'secret://mykey', API_TIMEOUT_MS: '30000' })
  })
  it('auth-token sets the token, removes api-key', () => {
    const out = setAnthropicAuthMode({ ANTHROPIC_API_KEY: 'secret://k' }, 'auth-token', 'secret://tok')
    expect(out).toEqual({ ANTHROPIC_AUTH_TOKEN: 'secret://tok' })
  })
  it('token modes require a tokenRef', () => {
    expect(() => setAnthropicAuthMode({}, 'api-key')).toThrow(/token/i)
  })
  it('throws when a custom base URL is present (non-Anthropic provider)', () => {
    expect(() => setAnthropicAuthMode({ ANTHROPIC_BASE_URL: 'https://z.ai' }, 'login')).toThrow(/base URL|custom provider/i)
  })
})
