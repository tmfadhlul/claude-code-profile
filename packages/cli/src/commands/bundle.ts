import type { Command } from 'commander'
import {
  exportBundle, importBundle, collectAssets, writeAssets, parseManifest, serializeManifest,
  saveManifest, executeApply, backupFiles,
} from 'ccprofiles-core'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerBundleCommands(program: Command, ctx: CliContext): void {
  program.command('export <file>').description('export manifest + assets as a portable bundle (no secrets)')
    .action(async (file: string) => {
      const m = await requireManifest(ctx)
      const assets = await collectAssets(m, ctx.platform)
      await writeFile(file, exportBundle(serializeManifest(m), assets))
      console.log(`exported ${m.profiles.length} profiles + ${Object.keys(assets).length} asset files to ${file}`)
    })

  program.command('import <file>').description('import a bundle and apply it')
    .option('--dry-run')
    .option('--yes', 'apply without the safety confirmation')
    .action(async (file: string, opts: { dryRun?: boolean; yes?: boolean }) => {
      const { manifestYaml, assets } = importBundle(await readFile(file))
      const m = parseManifest(manifestYaml) // also runs assertSafeManifest — rejects injectable identifiers
      console.log(`bundle: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers, ${Object.keys(assets).length} asset files`)
      if (!opts.dryRun && !opts.yes) {
        console.log('')
        console.log('⚠️  Applying a bundle writes shell launcher functions to your rc file and MCP server')
        console.log('    commands to your Claude config — both execute code on your machine. Only import')
        console.log('    bundles you created or trust. Re-run with --yes to proceed (or --dry-run to preview).')
        process.exitCode = 1
        return
      }
      if (!opts.dryRun) {
        await backupFiles([join(ctx.manifestRoot, 'manifest.yaml')], ctx.backupRoot, stamp())
        await saveManifest(ctx.manifestRoot, m)
        await writeAssets(assets, m, ctx.platform)
      }
      const actions = await planActions(ctx, m)
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
    })
}
