import type { Command } from 'commander'
import { discoverProfiles, executeApply, liveProfileName, saveManifest, scanSessions } from 'ccprofiles-core'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

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
    const live = await discoverProfiles(ctx.home)
    const rows = await scanSessions({
      sharedRoot: join(ctx.manifestRoot, 'shared'),
      profiles: live.map(lp => ({ name: liveProfileName(lp), dir: lp.dir, agent: lp.agent })),
    })
    if (!rows.length) { console.log('no sessions found'); return }
    for (const p of rows) {
      console.log(`\n[${p.scope}/${p.agent}] ${p.project}`)
      for (const s of p.sessions)
        console.log(`  ${s.id}  ${String(s.messageCount).padStart(4)} msg  ${s.firstPrompt ?? '(no prompt)'}`)
    }
  })
}
