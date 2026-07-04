import type { Command } from 'commander'
import {
  exportBundle, importBundle, collectAssets, writeAssets, parseManifest, serializeManifest,
  saveManifest, discoverProfiles, planApply, executeApply, backupFiles,
} from '@ccprofiles/core'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'

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
    .action(async (file: string, opts: { dryRun?: boolean }) => {
      const { manifestYaml, assets } = importBundle(await readFile(file))
      const m = parseManifest(manifestYaml)
      console.log(`bundle: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers, ${Object.keys(assets).length} asset files`)
      if (!opts.dryRun) {
        await backupFiles([join(ctx.manifestRoot, 'manifest.yaml')], ctx.backupRoot, stamp())
        await saveManifest(ctx.manifestRoot, m)
        await writeAssets(assets, m, ctx.platform)
      }
      const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
    })
}
