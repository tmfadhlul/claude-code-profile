import type { Command } from 'commander'
import { executeApply, saveManifest } from 'ccprofiles-core'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerPluginCommands(program: Command, ctx: CliContext): void {
  const plugins = program.command('plugins').description('share Claude Code plugins across profiles')

  async function setShared(name: string, on: boolean): Promise<void> {
    const m = await requireManifest(ctx)
    const pr = m.profiles.find(p => p.name === name)
    if (!pr) throw new Error(`unknown profile: ${name}`)
    pr.sharedPlugins = on
    await saveManifest(ctx.manifestRoot, m)
    const actions = await planActions(ctx, m)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
    for (const line of r.performed) console.log(line)
  }

  plugins.command('share <profile>').description("pool this profile's plugins with other shared profiles")
    .action((name: string) => setShared(name, true))
  plugins.command('unshare <profile>').description('stop sharing; keep a local snapshot of the pool')
    .action((name: string) => setShared(name, false))
}
