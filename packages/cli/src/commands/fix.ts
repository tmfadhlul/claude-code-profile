import type { Command } from 'commander'
import { discoverProfiles, liveProfileName, planPluginVersionDrift } from 'ccprofiles-core'
import type { CliContext } from '../context.js'
import { claudeRunner } from './plugins.js'
import { migrateRcSecrets } from './secrets.js'

/**
 * Apply the doctor findings that have a safe, mechanical, non-destructive remedy — the "things you
 * can clear" without a human deciding anything. Two classes today:
 *
 *  1. Cross-profile plugin version drift → run `claude plugin update` in every profile that has the
 *     drifted plugin, converging them all on the marketplace's latest. This is the motivating fix:
 *     mismatched claude-mem versions across profiles fight over the shared ~/.claude-mem worker and
 *     leak processes (see planPluginVersionDrift). `update` only ever moves to latest, so a profile
 *     already there no-ops — that's why every holder is updated, not just the laggard.
 *  2. Plaintext API keys in the shell rc file → migrate into the OS keychain (backs up first).
 *
 * Deliberately NOT auto-fixed (reported by doctor, left for a human): broken symlinks (which target?
 * remove or repair?), a configured git remote on the manifest repo (may be intentional), and
 * plaintext tokens in a profile's settings.json (needs the profile adopted into the manifest first).
 */
export async function runAutoFixes(ctx: CliContext): Promise<{ fixed: string[] }> {
  const fixed: string[] = []
  const live = await discoverProfiles(ctx.home)
  const claude = live.filter(l => l.agent === 'claude')

  const drift = planPluginVersionDrift(claude.map(l => ({ name: liveProfileName(l), versions: l.installedPluginVersions })))
  if (drift.length) {
    const runner = ctx.pluginRunner ?? claudeRunner()
    for (const d of drift) {
      for (const lp of claude) {
        if (!lp.installedPlugins.includes(d.id)) continue
        await runner.update(lp.dir, d.id)
        fixed.push(`updated ${d.id} in ${liveProfileName(lp)} → latest`)
      }
    }
  }

  for (const secret of await migrateRcSecrets(ctx, {})) fixed.push(`migrated plaintext secret ${secret} → keychain`)

  return { fixed }
}

export function registerFixCommand(program: Command, ctx: CliContext): void {
  program.command('fix')
    .description('auto-fix the doctor findings that have a safe remedy (plugin version drift, plaintext rc secrets)')
    .action(async () => {
      const { fixed } = await runAutoFixes(ctx)
      if (!fixed.length) { console.log('nothing to fix — no auto-fixable findings'); return }
      for (const f of fixed) console.log(`fixed: ${f}`)
      console.log(`fix: cleared ${fixed.length} finding(s) — run 'ccprofiles doctor' for anything left`)
    })
}
