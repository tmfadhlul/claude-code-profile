import type { Command } from 'commander'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import {
  delegateEnv, executeApply, renderPath, saveManifest, type Manifest, type ProfileDecl,
} from 'ccprofiles-core'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'
import { secretsStore } from './secrets.js'

type Failure = { error: string; transcript_path: string; cwd?: string; agent_id?: string }
const CONTINUE = 'Continue the latest unfinished request after a rate limit. Check the transcript and current files before repeating any actions.'

function claudeProfile(m: Manifest, name: string): ProfileDecl {
  const p = m.profiles.find(p => p.name === name)
  if (!p || (p.agent ?? 'claude') !== 'claude') throw new Error(`unknown Claude profile: ${name}`)
  return p
}

async function profileEnv(ctx: CliContext, p: ProfileDecl): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  let store: Awaited<ReturnType<typeof secretsStore>> | undefined
  for (const [key, value] of Object.entries(p.env)) {
    if (value.startsWith('secret://')) {
      store ??= await secretsStore(ctx)
      const secret = await store.get(value.slice('secret://'.length))
      if (secret === null) throw new Error(`secret not found: ${value} (for ${key})`)
      values[key] = secret
    } else values[key] = value
  }
  return delegateEnv(ctx.env, 'CLAUDE_CONFIG_DIR', renderPath(p.dir, ctx.platform), values)
}

/** Each Claude child gets its own signal path; only its matching rate-limit hook can switch it. */
export async function runFallback(
  ctx: CliContext, m: Manifest, start: string, args: string[],
  spawnClaude: typeof spawn = spawn,
): Promise<number> {
  let current = claudeProfile(m, start)
  const attempted = new Set<string>()
  const signalDir = await mkdtemp(join(tmpdir(), 'ccprofiles-fallback-'))
  let resumePath: string | undefined
  let launchCwd = process.cwd()
  try {
    while (true) {
      attempted.add(current.name)
      const signal = join(signalDir, `${attempted.size}.json`)
      const settings = JSON.stringify({ hooks: { StopFailure: [{ matcher: 'rate_limit', hooks: [{ type: 'command', command: 'ccprofiles fallback hook' }] }] } })
      const launchArgs = [
        '--settings', settings,
        ...(current.skipPermissions ? ['--dangerously-skip-permissions'] : []),
        ...(resumePath ? ['--resume', resumePath, '--fork-session', CONTINUE] : args),
      ]
      const env = { ...(await profileEnv(ctx, current)), CCPROFILES_FALLBACK_SIGNAL: signal }
      const child = spawnClaude('claude', launchArgs, { cwd: launchCwd, env, stdio: 'inherit' })
      let switchRequested = false
      const timer = setInterval(() => {
        if (existsSync(signal) && !switchRequested) {
          switchRequested = true
          child.kill('SIGTERM')
        }
      }, 100)
      const code = await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (status, sig) => resolve(status ?? (sig ? 128 : 1)))
      }).finally(() => clearInterval(timer))
      if (!existsSync(signal)) return code
      const failure = JSON.parse(await readFile(signal, 'utf8')) as Failure
      if (failure.error !== 'rate_limit' || !isAbsolute(failure.transcript_path) || !existsSync(failure.transcript_path))
        return code
      const next = current.fallback
      if (!next || attempted.has(next)) {
        process.stderr.write(`fallback: no unused profile after ${current.name}; stopping\n`)
        return code || 1
      }
      resumePath = failure.transcript_path
      if (failure.cwd && isAbsolute(failure.cwd) && existsSync(failure.cwd)) launchCwd = failure.cwd
      process.stderr.write(`fallback: ${current.name} reached limit; resuming with ${next}\n`)
      current = claudeProfile(m, next)
    }
  } finally {
    await rm(signalDir, { recursive: true, force: true })
  }
}

export function registerFallbackCommands(program: Command, ctx: CliContext): void {
  const fallback = program.command('fallback').description('automatically switch Claude profiles on a rate limit')

  fallback.command('set <from> <to>').description('use another Claude profile when this one reaches a limit')
    .option('--dry-run')
    .action(async (from: string, to: string, opts: { dryRun?: boolean }) => {
      const m = await requireManifest(ctx)
      const source = claudeProfile(m, from)
      claudeProfile(m, to)
      if (from === to) throw new Error('fallback profile must differ from source')
      if (opts.dryRun) { console.log(`[dry-run] fallback: ${from} → ${to}`); return }
      source.fallback = to
      await saveManifest(ctx.manifestRoot, m)
      await executeApply(await planActions(ctx, m), { backupRoot: ctx.backupRoot, stamp: new Date().toISOString().replace(/[:.]/g, '-') })
      console.log(`fallback: ${from} → ${to} (reload your shell)`)
    })

  fallback.command('clear <from>').description('remove automatic fallback')
    .option('--dry-run')
    .action(async (from: string, opts: { dryRun?: boolean }) => {
      const m = await requireManifest(ctx)
      if (opts.dryRun) { claudeProfile(m, from); console.log(`[dry-run] fallback: ${from} cleared`); return }
      delete claudeProfile(m, from).fallback
      await saveManifest(ctx.manifestRoot, m)
      await executeApply(await planActions(ctx, m), { backupRoot: ctx.backupRoot, stamp: new Date().toISOString().replace(/[:.]/g, '-') })
      console.log(`fallback: ${from} cleared (reload your shell)`)
    })

  fallback.command('run').requiredOption('--from <profile>')
    .allowUnknownOption().argument('[args...]')
    .action(async (args: string[], opts: { from: string }) => {
      process.exitCode = await runFallback(ctx, await requireManifest(ctx), opts.from, args)
    })

  fallback.command('hook').action(async () => {
    const signal = process.env.CCPROFILES_FALLBACK_SIGNAL
    if (!signal) return
    let input: Failure
    try {
      let body = ''
      for await (const chunk of process.stdin) body += chunk
      input = JSON.parse(body) as Failure
    } catch { return }
    if (input.error !== 'rate_limit' || input.agent_id || !isAbsolute(input.transcript_path)) return
    try { await writeFile(signal, JSON.stringify({ error: input.error, transcript_path: input.transcript_path, cwd: input.cwd }), { flag: 'wx', mode: 0o600 }) }
    catch { /* at most one signal per Claude process */ }
  })
}
