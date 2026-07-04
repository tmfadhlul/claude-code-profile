import type { Command } from 'commander'
import {
  discoverProfiles, buildManifest, saveManifest, planApply, executeApply,
} from '@ccprofiles/core'
import { requireManifest, type CliContext } from '../context.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerManifestCommands(program: Command, ctx: CliContext): void {
  program.command('status').description('show live-vs-manifest drift').action(async () => {
    const m = await requireManifest(ctx)
    const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
    if (actions.length === 0) { console.log('in sync'); return }
    const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: true })
    for (const line of res.performed) console.log(`pending: ${line}`)
  })

  program.command('apply').description('apply manifest to live configs')
    .option('--dry-run')
    .action(async (opts: { dryRun?: boolean }) => {
      const m = await requireManifest(ctx)
      const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
      if (actions.length === 0) { console.log('in sync — nothing to do'); return }
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
      if (res.backupDir) console.log(`backups: ${res.backupDir}`)
    })

  program.command('snapshot').description('overwrite manifest from live state').action(async () => {
    const m = buildManifest(await discoverProfiles(ctx.home), ctx.platform)
    await saveManifest(ctx.manifestRoot, m)
    console.log(`snapshot: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers`)
  })

  program.command('create <name>').description('create a new profile')
    .option('--from <profile>', 'copy mcp list and links from an existing profile')
    .action(async (name: string, opts: { from?: string }) => {
      const m = await requireManifest(ctx)
      if (m.profiles.some(p => p.name === name)) throw new Error(`profile exists: ${name}`)
      const src = opts.from ? m.profiles.find(p => p.name === opts.from) : null
      if (opts.from && !src) throw new Error(`unknown profile: ${opts.from}`)
      m.profiles.push({
        name,
        dir: `{home}/.claude-${name}`,
        launcher: `cl-${name}`,
        auth: 'env',
        env: {},
        links: src ? { ...src.links } : (m.hub ? { skills: 'hub', commands: 'hub' } : {}),
        mcp: src ? [...src.mcp] : [],
      })
      await saveManifest(ctx.manifestRoot, m)
      const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
      await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
      console.log(`profile "${name}" created — launcher: cl-${name} (restart your shell)`)
    })
}
