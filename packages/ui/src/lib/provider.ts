export const SECRET_PREFIX = 'secret://'

export type TokenVar = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'

export type ProviderForm = {
  baseUrl: string
  tokenVar: TokenVar
  token: { secret: boolean; value: string } // value = secret name when secret, plain value otherwise; '' = unset
  models: { opus: string; sonnet: string; haiku: string }
  timeoutMs: string
}

export type ProviderPreset = { id: string; label: string; baseUrl: string; tokenVar: TokenVar }

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'zai', label: 'z.ai (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', tokenVar: 'ANTHROPIC_AUTH_TOKEN' },
  { id: 'mimo', label: 'mimo', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic', tokenVar: 'ANTHROPIC_AUTH_TOKEN' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', tokenVar: 'ANTHROPIC_AUTH_TOKEN' },
]

const MODEL_VARS = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
} as const

const FORM_KEYS: string[] = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  MODEL_VARS.opus, MODEL_VARS.sonnet, MODEL_VARS.haiku, 'API_TIMEOUT_MS',
]

export function emptyProviderForm(): ProviderForm {
  return {
    baseUrl: '', tokenVar: 'ANTHROPIC_AUTH_TOKEN', token: { secret: true, value: '' },
    models: { opus: '', sonnet: '', haiku: '' }, timeoutMs: '',
  }
}

/** Split a settingsEnv map into the labeled provider form + leftover advanced keys. Lossless with mergeProviderEnv. */
export function splitProviderEnv(env: Record<string, string>): { form: ProviderForm; advanced: Record<string, string> } {
  const advanced: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!FORM_KEYS.includes(k)) advanced[k] = v
  const tokenVar: TokenVar = env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_AUTH_TOKEN === undefined
    ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
  const otherVar: TokenVar = tokenVar === 'ANTHROPIC_AUTH_TOKEN' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
  if (env[otherVar] !== undefined) advanced[otherVar] = env[otherVar] // both present — don't lose the other one
  const raw = env[tokenVar] ?? ''
  return {
    form: {
      baseUrl: env.ANTHROPIC_BASE_URL ?? '',
      tokenVar,
      token: raw.startsWith(SECRET_PREFIX)
        ? { secret: true, value: raw.slice(SECRET_PREFIX.length) }
        : { secret: raw === '', value: raw },
      models: { opus: env[MODEL_VARS.opus] ?? '', sonnet: env[MODEL_VARS.sonnet] ?? '', haiku: env[MODEL_VARS.haiku] ?? '' },
      timeoutMs: env.API_TIMEOUT_MS ?? '',
    },
    advanced,
  }
}

/** Merge the labeled form + advanced keys back into one settingsEnv map. Blank fields are omitted. */
export function mergeProviderEnv(form: ProviderForm, advanced: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...advanced }
  if (form.baseUrl.trim()) out.ANTHROPIC_BASE_URL = form.baseUrl.trim()
  if (form.token.value.trim()) out[form.tokenVar] = form.token.secret ? SECRET_PREFIX + form.token.value.trim() : form.token.value.trim()
  for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
    if (form.models[slot].trim()) out[MODEL_VARS[slot]] = form.models[slot].trim()
  }
  if (form.timeoutMs.trim()) out.API_TIMEOUT_MS = form.timeoutMs.trim()
  return out
}

export function detectPreset(baseUrl: string): string {
  if (!baseUrl) return 'anthropic'
  return PROVIDER_PRESETS.find(p => p.baseUrl === baseUrl)?.id ?? 'custom'
}

/** New form for a chosen preset: base URL + token var set, models/timeout cleared, token selection kept. */
export function applyPreset(form: ProviderForm, preset: ProviderPreset): ProviderForm {
  return { ...emptyProviderForm(), baseUrl: preset.baseUrl, tokenVar: preset.tokenVar, token: form.token }
}

/** Form cloned from another profile's provider config, with the token value left for the user to fill. */
export function copyFromEnv(env: Record<string, string>): ProviderForm {
  return { ...splitProviderEnv(env).form, token: { secret: true, value: '' } }
}
