import type { Command } from 'commander'
import {
  discoverProfiles, buildManifest, saveManifest, loadManifest, preserveSecretRefs, executeApply,
} from 'ccprofiles-core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'
import { secretsStore } from './secrets.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerManifestCommands(program: Command, ctx: CliContext): void {
  program.command('status').description('show live-vs-manifest drift').action(async () => {
    const m = await requireManifest(ctx)
    const actions = await planActions(ctx, m)
    if (actions.length === 0) { console.log('in sync'); return }
    const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: true })
    for (const line of res.performed) console.log(`pending: ${line}`)
  })

  program.command('apply').description('apply manifest to live configs')
    .option('--dry-run')
    .action(async (opts: { dryRun?: boolean }) => {
      const m = await requireManifest(ctx)
      const actions = await planActions(ctx, m)
      if (actions.length === 0) { console.log('in sync — nothing to do'); return }
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
      if (res.backupDir) console.log(`backups: ${res.backupDir}`)
    })

  program.command('snapshot').description('overwrite manifest from live state').action(async () => {
    const m = buildManifest(await discoverProfiles(ctx.home), ctx.platform)
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const oldM = await loadManifest(ctx.manifestRoot)
      let store: Awaited<ReturnType<typeof secretsStore>> | null = null
      await preserveSecretRefs(m, oldM, async name => { store ??= await secretsStore(ctx); return store.get(name) })
    }
    await saveManifest(ctx.manifestRoot, m)
    console.log(`snapshot: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers`)
  })

  program.command('create <name>').description('create a new profile')
    .option('--from <profile>', 'copy mcp list and links from an existing profile')
    .option('--agent <agent>', 'agent to launch: claude or codex', 'claude')
    .action(async (name: string, opts: { from?: string; agent: string }) => {
      if (opts.agent !== 'claude' && opts.agent !== 'codex') throw new Error('--agent must be claude or codex')
      const suffix = opts.agent === 'codex' && name.startsWith('codex-') ? name.slice('codex-'.length) : name
      if (!suffix) throw new Error('profile name must not be empty')
      const profileName = opts.agent === 'codex' ? `codex-${suffix}` : name
      const m = await requireManifest(ctx)
      if (m.profiles.some(p => p.name === profileName)) throw new Error(`profile exists: ${profileName}`)
      const src = opts.from ? m.profiles.find(p => p.name === opts.from) : null
      if (opts.from && !src) throw new Error(`unknown profile: ${opts.from}`)
      m.profiles.push({
        agent: opts.agent,
        name: profileName,
        dir: `{home}/.${opts.agent}-${suffix}`,
        launcher: `${opts.agent === 'codex' ? 'cx' : 'cl'}-${suffix}`,
        auth: 'env',
        env: {},
        links: src ? { ...src.links } : (m.hub ? { skills: 'hub', commands: 'hub' } : {}),
        mcp: src ? [...src.mcp] : [],
        settingsEnv: {},
        skipPermissions: false,
        sharedSessions: false,
        sharedPlugins: false,
      })
      await saveManifest(ctx.manifestRoot, m)
      const actions = await planActions(ctx, m)
      await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
      console.log(`profile "${profileName}" created — launcher: ${opts.agent === 'codex' ? 'cx' : 'cl'}-${suffix} (restart your shell)`)
    })
}
