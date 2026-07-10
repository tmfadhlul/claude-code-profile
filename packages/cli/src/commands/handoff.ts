import type { Command } from 'commander'
import {
  scanSessions, readSessionTranscript, renderHandoffMarkdown,
  findLastSessionForCwd, buildHandoffLaunch, renderPath,
} from 'ccprofiles-core'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { secretsStore } from './secrets.js'

const SECRET_PREFIX = 'secret://'
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

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

export function registerHandoffCommands(program: Command, ctx: CliContext): void {
  program.command('handoff')
    .description("hand off the current project's latest session to another profile's agent")
    .requiredOption('--from <profile>', 'source profile (owns the session)')
    .requiredOption('--to <profile>', 'target profile (agent to open)')
    .option('--print', 'write the handoff file and print the launch command instead of opening the agent')
    .action(async (opts: { from: string; to: string; print?: boolean }) => {
      const m = await requireManifest(ctx)
      const src = m.profiles.find(p => p.name === opts.from)
      if (!src) throw new Error(`unknown profile: ${opts.from}`)
      const target = m.profiles.find(p => p.name === opts.to)
      if (!target) throw new Error(`unknown profile: ${opts.to}`)
      if (src.name === target.name) throw new Error('source and target are the same profile')

      const srcAgent = src.agent ?? 'claude'
      const targetAgent = target.agent ?? 'claude'
      const sharedRoot = join(ctx.manifestRoot, 'shared')
      const profiles = m.profiles.map(p => ({ name: p.name, dir: renderPath(p.dir, ctx.platform), agent: p.agent ?? 'claude' }))
      const srcDir = renderPath(src.dir, ctx.platform)

      // effective scope: 'shared' if the source's session dir is pooled, else the profile name
      const srcSessionDir = join(srcDir, srcAgent === 'codex' ? 'sessions' : 'projects')
      let scope = src.name
      try { if ((await lstat(srcSessionDir)).isSymbolicLink()) scope = 'shared' } catch { /* not pooled */ }

      const cwd = process.cwd()
      const scanned = await scanSessions({ sharedRoot, profiles })
      const found = findLastSessionForCwd(scanned, cwd, scope, srcAgent)
      if (!found) throw new Error(`no ${opts.from} session found for this project (${cwd})`)

      const transcript = await readSessionTranscript({ sharedRoot, profiles, agent: srcAgent, scope: found.scope, id: found.id })
      if (!transcript) throw new Error(`could not read session ${found.id}`)

      const dir = join(ctx.manifestRoot, 'handoffs')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${stamp()}-${found.id}.md`)
      await writeFile(file, renderHandoffMarkdown(transcript), 'utf8')

      const targetEnv = await resolveEnv(ctx, target.env)
      const launch = buildHandoffLaunch({
        targetAgent, targetDir: renderPath(target.dir, ctx.platform), targetEnv,
        skipPermissions: target.skipPermissions, transcriptPath: file,
        srcName: src.name, srcAgent, cwd,
      })

      if (opts.print) {
        console.log(`handoff file: ${file}`)
        console.log(`command: ${launch.command} ${launch.args.map(a => JSON.stringify(a)).join(' ')}`)
        console.log(`env: ${Object.entries(launch.env).map(([k, v]) => `${k}=${v}`).join(' ')}`)
        console.log(`cwd: ${launch.cwd}`)
        return
      }
      const res = spawnSync(launch.command, launch.args, { stdio: 'inherit', cwd: launch.cwd, env: { ...process.env, ...launch.env } })
      if (res.error) throw res.error
      if (typeof res.status === 'number' && res.status !== 0) process.exitCode = res.status
    })
}
