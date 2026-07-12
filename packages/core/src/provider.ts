export type AnthropicAuthMode = 'login' | 'api-key' | 'auth-token'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** Derive the current Anthropic auth mode from a settingsEnv map. */
export function anthropicAuthMode(env: Record<string, string>): AnthropicAuthMode {
  if (env[API_KEY] !== undefined) return 'api-key'
  if (env[AUTH_TOKEN] !== undefined) return 'auth-token'
  return 'login'
}

/**
 * New settingsEnv with `mode` applied. Non-auth keys preserved. `login` removes
 * both token vars; `api-key`/`auth-token` set that var to `tokenRef` and remove
 * the other. Throws if env has a custom ANTHROPIC_BASE_URL (non-Anthropic provider)
 * or if a token mode is chosen without a tokenRef.
 */
export function setAnthropicAuthMode(
  env: Record<string, string>,
  mode: AnthropicAuthMode,
  tokenRef?: string,
): Record<string, string> {
  if (env[BASE_URL] !== undefined && env[BASE_URL].trim())
    throw new Error(`profile uses a custom provider base URL (${env[BASE_URL]}) — manage its token in the Provider editor, not as an Anthropic auth mode`)
  const out = { ...env }
  delete out[API_KEY]
  delete out[AUTH_TOKEN]
  if (mode === 'login') return out
  if (!tokenRef || !tokenRef.trim()) throw new Error(`${mode} mode requires a token reference`)
  out[mode === 'api-key' ? API_KEY : AUTH_TOKEN] = tokenRef.trim()
  return out
}
