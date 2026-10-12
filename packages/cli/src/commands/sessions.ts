import type { Command } from 'commander'
import {
  discoverProfiles, executeApply, liveProfileName, loadManifest, saveManifest, scanSessions, recentSessions,
  resumeCommand, sessionOwner, type ProjectSessions,
} from 'ccprofiles-core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

/** Every session row on disk, plus the profiles (with launcher/sharing from the manifest, when
 *  there is one) needed to build resume commands. */
export async function loadSessions(ctx: CliContext) {
  const live = await discoverProfiles(ctx.home)
  const decls = existsSync(join(ctx.manifestRoot, 'manifest.yaml')) ? (await loadManifest(ctx.manifestRoot)).profiles : []
  const profiles = live.map(lp => {
    const name = liveProfileName(lp)
    const decl = decls.find(d => d.name === name && (d.agent ?? 'claude') === lp.agent)
    return { name, dir: lp.dir, agent: lp.agent, launcher: decl?.launcher ?? null, sharedSessions: decl?.sharedSessions ?? false }
  })
  const rows = await scanSessions({ sharedRoot: join(ctx.manifestRoot, 'shared'), profiles })
  return { rows, profiles }
}

/** The most recently chatted-in sessions, each with a paste-ready resume command. */
export function recentWithResume(rows: ProjectSessions[], profiles: Awaited<ReturnType<typeof loadSessions>>['profiles'], limit = 10) {
  return recentSessions(rows, limit).map(r => ({ ...r, resume: resumeCommand(r, sessionOwner(r, profiles)) }))
}

export function registerSessionCommands(program: Command, ctx: CliContext): void {
  const sessions = program.command('sessions').description('share Claude Code or Codex session history across profiles')

  async function setShared(name: string, on: boolean): Promise<void> {
    const m = await requireManifest(ctx)
    const pr = m.profiles.find(p => p.name === name)
    if (!pr) throw new Error(`unknown profile: ${name}`)
    pr.sharedSessions = on
    await saveManifest(ctx.manifestRoot, m)
    const actions = await planActions(ctx, m)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
    for (const line of r.performed) console.log(line)
  }

  sessions.command('share <profile>').description("pool this profile's sessions with other shared profiles")
    .action((name: string) => setShared(name, true))
  sessions.command('unshare <profile>').description('stop sharing; keep a local snapshot of the pool')
    .action((name: string) => setShared(name, false))

  sessions.command('list').description('list projects and their sessions').action(async () => {
    const { rows } = await loadSessions(ctx)
    if (!rows.length) { console.log('no sessions found'); return }
    for (const p of rows) {
      console.log(`\n[${p.scope}/${p.agent}] ${p.project}`)
      for (const s of p.sessions)
        console.log(`  ${s.id}  ${String(s.messageCount).padStart(4)} msg  ${s.firstPrompt ?? '(no prompt)'}`)
    }
  })

  sessions.command('recent').description('the sessions you chatted in most recently, with resume commands')
    .option('-n, --limit <n>', 'how many to show', '10')
    .action(async (opts: { limit: string }) => {
      const limit = Number(opts.limit)
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer')
      const { rows, profiles } = await loadSessions(ctx)
      const recent = recentWithResume(rows, profiles, limit)
      if (!recent.length) { console.log('no sessions found'); return }
      for (const r of recent) {
        console.log(`\n${new Date(r.session.lastActivity).toLocaleString()}  [${r.scope}/${r.agent}] ${r.project}`)
        console.log(`  ${(r.session.title ?? r.session.firstPrompt)?.split('\n')[0] ?? '(no prompt)'}`)
        console.log(`  ${r.resume}`)
      }
    })
}
