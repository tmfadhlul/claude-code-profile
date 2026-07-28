import type { Command } from 'commander'
import { buildDelegateLaunch, renderPath, scopeReport } from 'ccprofiles-core'
import { spawnSync } from 'node:child_process'
import { requireManifest, type CliContext } from '../context.js'
import { secretsStore } from './secrets.js'

const SECRET_PREFIX = 'secret://'

/**
 * Fingerprint every file git reports as changed, so we can tell afterwards which ones the
 * delegate touched. Fingerprint is `status:blobhash`, so a further edit to an already-dirty
 * file is caught — a bare path set would miss it.
 * ponytail: one `git hash-object` per dirty file. Fine for a normal working tree; if someone
 * delegates against thousands of dirty files, batch it through `git hash-object --stdin-paths`.
 *
 * LIMITATION — this attributes every change in the tree to the delegate we just ran, because a
 * snapshot diff cannot tell writers apart. That is exact for one delegate at a time, and wrong
 * for concurrent delegates sharing a tree: each one's "after" contains the others' work, so
 * they report each other's files as violations. Parallel runs need real isolation (a worktree
 * per delegate), not a better diff.
 */
function snapshotChanges(cwd: string): Map<string, string> | null {
  // -uall: without it git collapses a new directory to `src/web/`, so a scope check sees one
  // opaque entry instead of the files inside it
  const res = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd, encoding: 'utf8' })
  if (res.status !== 0) return null // not a git repo (or git missing)
  const out = new Map<string, string>()
  const records = res.stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]
    if (!entry.trim()) continue
    const status = entry.slice(0, 2).trim()
    const file = entry.slice(3)
    if (!file) continue
    // a rename is TWO records: "R  <new>\0<old>\0". Consume the old path here, or the next
    // loop treats it as a fresh entry and slices 3 chars off a bare filename.
    if (status.startsWith('R') || status.startsWith('C')) {
      const old = records[++i]
      if (old) out.set(old, 'renamed-away')
    }
    const st = spawnSync('git', ['--no-optional-locks', 'hash-object', '--', file],
      { cwd, encoding: 'utf8' })
    out.set(file, `${status}:${st.status === 0 ? st.stdout.trim() : 'missing'}`)
  }
  return out
}

/** Current commit, or null outside a repo / on an unborn branch. */
function headCommit(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * Paths changed by commits the delegate made. A delegate told to "commit your work" leaves the
 * tree clean, so a status-only check reports zero touched files and waves the work through.
 */
function committedPaths(cwd: string, from: string | null, to: string | null): string[] {
  if (!from || !to || from === to) return []
  const r = spawnSync('git', ['diff', '--name-only', '-z', `${from}..${to}`], { cwd, encoding: 'utf8' })
  if (r.status !== 0) return []
  return r.stdout.split('\0').filter(f => f.trim())
}

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
    .option('--scope <glob>', "declare a path lane, e.g. src/web/** or src/web; reports files touched outside it and exits 3. Accurate for one delegate at a time (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--print', 'print the launch command instead of running it')
    .argument('[prompt...]', 'the task; if omitted, read from stdin')
    .action(async (promptWords: string[], opts: {
      to: string; model?: string; cwd?: string; json?: boolean; skipPermissions?: boolean
      print?: boolean; scope: string[]
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

      const scopes = opts.scope ?? []
      const before = scopes.length ? snapshotChanges(launch.cwd) : null
      if (scopes.length && !before) {
        throw new Error(`--scope needs a git repo — ${launch.cwd} is not one (or git is unavailable)`)
      }
      const headBefore = before ? headCommit(launch.cwd) : null

      const res = spawnSync(launch.command, launch.args, { stdio: 'inherit', cwd: launch.cwd, env: launch.env })
      if (res.error) throw res.error
      // A signal-killed child has status === null. Reporting that as success lets a caller fold
      // truncated output in as a completed result.
      if (res.signal) {
        console.error(`\ndelegate "${target.name}" was killed by ${res.signal} — output is incomplete`)
        process.exitCode = 1
      } else if (typeof res.status === 'number' && res.status !== 0) {
        process.exitCode = res.status
      }

      if (before) {
        const after = snapshotChanges(launch.cwd)
        const committed = committedPaths(launch.cwd, headBefore, headCommit(launch.cwd))
        const { touched, violations } = scopeReport(before, after ?? before, scopes, committed)
        console.error(`\ndelegate "${target.name}" touched ${touched.length} file(s)`)
        for (const f of touched) console.error(`  ${violations.includes(f) ? '✗' : ' '} ${f}`)
        if (violations.length) {
          // Nothing is reverted — the work stands. The non-zero exit is so a chained
          // `&& git merge` stops rather than folding in an out-of-lane change unseen.
          console.error(`\n${violations.length} file(s) outside scope [${scopes.join(', ')}] `
            + '— review before merging or before trusting a parallel run')
          // don't mask a real failure: "the delegate crashed" outranks "it strayed"
          if (!process.exitCode) process.exitCode = 3
        }
      }
    })
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
