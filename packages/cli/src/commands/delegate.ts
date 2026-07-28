import type { Command } from 'commander'
import { buildDelegateLaunch, renderPath } from 'ccprofiles-core'
import { spawnSync } from 'node:child_process'
import { requireManifest, type CliContext } from '../context.js'
import { secretsStore } from './secrets.js'

const SECRET_PREFIX = 'secret://'

async function resolveEnv(ctx: CliContext, env: Record<string, string>): Promise<Record<string, string>> {
  let store: Awaited<ReturnType<typeof secretsStore>> | null = null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v.startsWith(SECRET_PREFIX)) {
      store ??= await secretsStore(ctx)
      const val = await store.get(v.slice(SECRET_PREFIX.length))
      if (val === null) throw new Error(`secret not found: ${v.slice(SECRET_PREFIX.length)} (for ${k})`)
      out[k] = val
    } else out[k] = v
  }
  return out
}

export function registerDelegateCommands(program: Command, ctx: CliContext): void {
  program.command('delegate')
    .description("run another profile's agent headlessly on one task and print its output")
    .requiredOption('--to <profile>', 'profile whose agent runs the task')
    .option('--model <model>', 'model to pass through (e.g. opus, which a gateway profile may remap)')
    .option('--cwd <dir>', 'working directory for the delegate (default: current directory)')
    .option('--json', 'return structured JSON instead of text (claude profiles only)')
    .option('--skip-permissions', 'let the delegate write files without prompting (headless cannot prompt)')
    .option('--print', 'print the launch command instead of running it')
    .argument('[prompt...]', 'the task; if omitted, read from stdin')
    .action(async (promptWords: string[], opts: {
      to: string; model?: string; cwd?: string; json?: boolean; skipPermissions?: boolean; print?: boolean
    }) => {
      const m = await requireManifest(ctx)
      const target = m.profiles.find(p => p.name === opts.to)
      if (!target) {
        throw new Error(`unknown profile: ${opts.to} (have: ${m.profiles.map(p => p.name).sort().join(', ')})`)
      }
      const targetAgent = target.agent ?? 'claude'
      if (opts.json && targetAgent === 'codex') {
        throw new Error('--json is claude-only; `codex exec` has no structured output mode')
      }

      const prompt = promptWords.length ? promptWords.join(' ') : await readStdin()
      if (!prompt.trim()) throw new Error('empty prompt — pass it as an argument or pipe it on stdin')

      // Headless agents cannot answer a permission prompt: without this the delegate stalls
      // or refuses every write, so surface it as a choice rather than a mystery hang.
      const skipPermissions = opts.skipPermissions ?? target.skipPermissions
      if (!skipPermissions) {
        console.error(`warning: profile "${target.name}" has skipPermissions=false — the delegate `
          + 'cannot write files unattended. Re-run with --skip-permissions to allow it.')
      }

      const launch = buildDelegateLaunch({
        targetAgent,
        targetDir: renderPath(target.dir, ctx.platform),
        targetEnv: await resolveEnv(ctx, target.env),
        skipPermissions,
        prompt,
        cwd: opts.cwd ?? process.cwd(),
        model: opts.model ?? null,
        json: opts.json,
        parentEnv: process.env,
      })

      if (opts.print) {
        console.log(`command: ${launch.command} ${launch.args.map(a => JSON.stringify(a)).join(' ')}`)
        console.log(`cwd: ${launch.cwd}`)
        console.log(`${targetAgent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}: ${launch.env[targetAgent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']}`)
        return
      }

      const res = spawnSync(launch.command, launch.args, { stdio: 'inherit', cwd: launch.cwd, env: launch.env })
      if (res.error) throw res.error
      if (typeof res.status === 'number' && res.status !== 0) process.exitCode = res.status
    })
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
