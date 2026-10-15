import type { Command } from 'commander'
import { discoverProfiles, liveProfileName, marketplaceOf, planPluginVersionDrift } from 'ccprofiles-core'
import type { CliContext } from '../context.js'
import { claudeRunner, prunePluginCaches } from './plugins.js'
import { migrateRcSecrets } from './secrets.js'
import { step } from '../progress.js'

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
export async function runAutoFixes(ctx: CliContext): Promise<{ fixed: string[]; failed: string[] }> {
  const fixed: string[] = [], failed: string[] = []
  step('Checking plugin versions across profiles')
  const versionsOf = async () => (await discoverProfiles(ctx.home)).filter(l => l.agent === 'claude')
  const claude = await versionsOf()
  const driftOf = (ps: typeof claude) => planPluginVersionDrift(ps.map(l => ({ name: liveProfileName(l), versions: l.installedPluginVersions })))

  const drift = driftOf(claude)
  if (drift.length) {
    const runner = ctx.pluginRunner ?? claudeRunner()
    for (const lp of claude) {
      const ids = drift.map(d => d.id).filter(id => lp.installedPlugins.includes(id))
      // The marketplace clone is per-profile and only refreshed on demand. Without this, `update`
      // in a profile whose clone predates the newest release no-ops — fix used to report success
      // while the drift stayed exactly where it was (see reconcileProfilePlugins).
      for (const mkt of new Set(ids.map(marketplaceOf).filter((m): m is string => !!m))) {
        try { await runner.marketplaceUpdate(lp.dir, mkt) }
        catch (e: any) { failed.push(`marketplace update ${mkt} in ${liveProfileName(lp)}: ${e.message}`) }
      }
      // one failing profile must not abort the rest (or the prune/secrets steps below)
      for (const id of ids) {
        try { await runner.update(lp.dir, id); fixed.push(`updated ${id} in ${liveProfileName(lp)} → latest`) }
        catch (e: any) { failed.push(`update ${id} in ${liveProfileName(lp)}: ${e.message}`) }
      }
    }
    // `update` exits 0 even when it changed nothing, so the only honest signal is re-reading disk.
    for (const d of driftOf(await versionsOf()))
      failed.push(`${d.id} still differs: ${Object.entries(d.byProfile).map(([p, v]) => `${p}=${v}`).join(', ')}`)
  }

  // Version parity (above) is not enough: claude-mem's hook launches by newest cache-dir MTIME, not
  // by the pin, so a leftover old version dir still gets run and revives the shared-worker leak.
  // Prune every profile down to one claude-mem version. Runs after the drift update so a freshly
  // installed latest is the survivor.
  step('Pruning stale plugin caches')
  for (const line of await prunePluginCaches(ctx)) fixed.push(line)

  step('Moving plaintext secrets to the keychain')
  for (const secret of await migrateRcSecrets(ctx, {})) fixed.push(`migrated plaintext secret ${secret} → keychain`)

  return { fixed, failed }
}

export function registerFixCommand(program: Command, ctx: CliContext): void {
  program.command('fix')
    .description('auto-fix the doctor findings that have a safe remedy (plugin version drift, plaintext rc secrets)')
    .action(async () => {
      const { fixed, failed } = await runAutoFixes(ctx)
      for (const f of failed) console.error(`failed: ${f}`)
      if (failed.length) process.exitCode = 1
      if (!fixed.length) { if (!failed.length) console.log('nothing to fix — no auto-fixable findings'); return }
      for (const f of fixed) console.log(`fixed: ${f}`)
      console.log(`fix: cleared ${fixed.length} finding(s) — run 'ccprofiles doctor' for anything left`)
    })
}
