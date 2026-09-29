import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

type Window = { used_percentage?: number | null; resets_at?: number | null }
export interface StatuslineInput {
  model?: { display_name?: string; id?: string }
  workspace?: { current_dir?: string }
  cwd?: string
  worktree?: { branch?: string }
  context_window?: { total_input_tokens?: number; total_output_tokens?: number }
  rate_limits?: { five_hour?: Window; seven_day?: Window; fable?: Window }
}

const RESET = '\x1b[0m'
function colored(value: string, code: string, bold = false): string {
  return `\x1b[${bold ? '1;' : ''}${code}m${value}${RESET}`
}
function percent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
}
function tokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
function countdown(epoch: number | null | undefined, now: number): string {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return '—'
  const mins = Math.floor((epoch * 1000 - now) / 60000)
  if (mins < 0) return '—'
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${String(Math.floor(mins % 1440 / 60)).padStart(2, '0')}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`
  return `${mins}m`
}
function profileName(configDir: string | undefined): string {
  const name = basename((configDir ?? '.claude').replace(/[\\/]+$/, ''))
  return name.startsWith('.claude-') ? name.slice('.claude-'.length) : 'default'
}

/** Three-line layout based on the maintainer's ccstatusline format, using Claude's status payload. */
export function renderStatusline(
  input: StatuslineInput, configDir: string | undefined,
  opts: { now?: number; branch?: string } = {},
): string {
  const cwd = input.workspace?.current_dir ?? input.cwd
  let branch = opts.branch ?? input.worktree?.branch ?? ''
  if (!branch && cwd) try {
    branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf8', timeout: 400, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { /* no repository */ }
  const context = input.context_window
  const count = (context?.total_input_tokens ?? 0) + (context?.total_output_tokens ?? 0)
  const model = input.model?.display_name ?? input.model?.id ?? 'Claude'
  const first = [
    colored(profileName(configDir), '32', true),
    colored(model, '36', true),
    colored(`${tokens(count)} ctx`, '37'),
    ...(branch ? [colored(branch, '35')] : []),
  ].join(' · ')
  const rates = input.rate_limits
  const second = [
    colored(`S: ${percent(rates?.five_hour?.used_percentage)}`, '94'),
    colored(`W: ${percent(rates?.seven_day?.used_percentage)}`, '94'),
    colored(`Fable: ${percent(rates?.fable?.used_percentage)}`, '33'),
  ].join(' · ')
  const now = opts.now ?? Date.now()
  const third = [
    colored(`Reset: ${countdown(rates?.five_hour?.resets_at, now)}`, '90'),
    colored(`W reset: ${countdown(rates?.seven_day?.resets_at, now)}`, '90'),
  ].join(' · ')
  return `${first}\n${second}\n${third}`
}

export async function statuslineFromStdin(): Promise<void> {
  let body = ''
  for await (const chunk of process.stdin) body += chunk
  let payload: StatuslineInput
  try { payload = JSON.parse(body) as StatuslineInput } catch { return }
  process.stdout.write(renderStatusline(payload, process.env.CLAUDE_CONFIG_DIR) + '\n')
}
