/**
 * Run another profile's agent headlessly as a subagent of the current session.
 *
 * `handoff` moves you to another profile interactively; this keeps you where you are and
 * calls the other profile for one scoped task, returning its output. That is the only way
 * to reach a different provider from inside a session: ANTHROPIC_BASE_URL / _AUTH_TOKEN are
 * process-wide, and a native subagent's `model` is validated against the *current* provider,
 * so a Claude session cannot dispatch a native subagent onto Kimi, GLM, or Codex.
 */

/** Env that pins a session to one account/provider. Must never survive into a delegate. */
export const PROVIDER_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // a direct auth override — left in place, the delegate authenticates as the *parent* account
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // gateways route and bill on these, so they re-point a delegate as surely as a base URL
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  // alternate backends: these switch the provider wholesale, ignoring ANTHROPIC_BASE_URL
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  // codex targets pin on the OpenAI pair, the exact mirror of the Anthropic leak
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const

export interface DelegateLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/**
 * Parent env minus every provider pin, plus the target's own.
 *
 * Without the strip, delegating from a gateway profile (kimi/z/mimo, which export
 * ANTHROPIC_BASE_URL) to a Claude profile would leave the gateway's base URL in place: the
 * target would authenticate as the Claude profile but send its traffic to the gateway. The
 * delegate would appear to work while silently running on the wrong model.
 */
export function delegateEnv(
  parentEnv: Record<string, string | undefined>,
  homeVar: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME',
  targetDir: string,
  targetEnv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue
    if ((PROVIDER_ENV_KEYS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  out[homeVar] = targetDir
  return { ...out, ...targetEnv }
}

export function buildDelegateLaunch(opts: {
  targetAgent: 'claude' | 'codex'
  targetDir: string
  targetEnv: Record<string, string>
  skipPermissions: boolean
  prompt: string
  cwd: string
  model?: string | null
  json?: boolean
  parentEnv?: Record<string, string | undefined>
}): DelegateLaunch {
  const codex = opts.targetAgent === 'codex'
  const homeVar = codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const args: string[] = codex ? ['exec'] : ['-p']

  if (opts.model) args.push(codex ? '-m' : '--model', opts.model)
  // codex exec has no --output-format; the caller is told rather than silently given text
  if (opts.json && !codex) args.push('--output-format', 'json')
  if (opts.skipPermissions) {
    args.push(codex ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions')
  }
  // codex resolves its workspace from --cd, not the spawn cwd
  if (codex) args.push('-C', opts.cwd)
  // `--` or a prompt like "-fix the tests" is parsed as an option by the child and the whole
  // delegation fails. Both `claude` (commander) and `codex exec` (clap) honour the separator.
  args.push('--', opts.prompt)

  return {
    command: codex ? 'codex' : 'claude',
    args,
    env: delegateEnv(opts.parentEnv ?? {}, homeVar, opts.targetDir, opts.targetEnv),
    cwd: opts.cwd,
  }
}
