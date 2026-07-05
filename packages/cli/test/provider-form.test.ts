import { describe, it, expect } from 'vitest'
import {
  splitProviderEnv, mergeProviderEnv, detectPreset, applyPreset, emptyProviderForm, copyFromEnv, PROVIDER_PRESETS,
} from '../../ui/src/lib/provider'

const ZAI_ENV = {
  ANTHROPIC_AUTH_TOKEN: 'secret://anthropic-auth-token-z',
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
}

describe('provider form mapping', () => {
  it('split/merge round-trips the z.ai shape losslessly', () => {
    const { form, advanced } = splitProviderEnv(ZAI_ENV)
    expect(form.baseUrl).toBe('https://api.z.ai/api/anthropic')
    expect(form.token).toEqual({ secret: true, value: 'anthropic-auth-token-z' })
    expect(form.models).toEqual({ opus: 'glm-5.2', sonnet: 'glm-5.1', haiku: 'glm-4.5-air' })
    expect(form.timeoutMs).toBe('3000000')
    expect(advanced).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    expect(mergeProviderEnv(form, advanced)).toEqual(ZAI_ENV)
  })

  it('plain token round-trips and API_KEY var is detected', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-plain', ANTHROPIC_BASE_URL: 'https://x.example' }
    const { form, advanced } = splitProviderEnv(env)
    expect(form.tokenVar).toBe('ANTHROPIC_API_KEY')
    expect(form.token).toEqual({ secret: false, value: 'sk-plain' })
    expect(mergeProviderEnv(form, advanced)).toEqual(env)
  })

  it('keeps the non-selected token var in advanced when both are present', () => {
    const env = { ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'b' }
    const { form, advanced } = splitProviderEnv(env)
    expect(form.tokenVar).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(advanced.ANTHROPIC_API_KEY).toBe('b')
    expect(mergeProviderEnv(form, advanced)).toEqual(env)
  })

  it('blank fields are omitted on merge; empty form yields advanced only', () => {
    expect(mergeProviderEnv(emptyProviderForm(), { FOO: '1' })).toEqual({ FOO: '1' })
  })

  it('detectPreset: exact match, custom, none', () => {
    expect(detectPreset('https://api.z.ai/api/anthropic')).toBe('zai')
    expect(detectPreset('https://token-plan-sgp.xiaomimimo.com/anthropic')).toBe('mimo')
    expect(detectPreset('https://elsewhere.example')).toBe('custom')
    expect(detectPreset('')).toBe('anthropic')
  })

  it('applyPreset sets url+var, clears models/timeout, keeps token', () => {
    const { form } = splitProviderEnv(ZAI_ENV)
    const mimo = PROVIDER_PRESETS.find(p => p.id === 'mimo')!
    const next = applyPreset(form, mimo)
    expect(next.baseUrl).toBe(mimo.baseUrl)
    expect(next.token).toEqual(form.token)
    expect(next.models).toEqual({ opus: '', sonnet: '', haiku: '' })
    expect(next.timeoutMs).toBe('')
  })

  it('copyFromEnv clones provider config but blanks the token', () => {
    const f = copyFromEnv(ZAI_ENV)
    expect(f.baseUrl).toBe(ZAI_ENV.ANTHROPIC_BASE_URL)
    expect(f.models.opus).toBe('glm-5.2')
    expect(f.token).toEqual({ secret: true, value: '' })
  })
})
