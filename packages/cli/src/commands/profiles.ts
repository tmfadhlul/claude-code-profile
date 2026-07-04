import type { Command } from 'commander'
import { discoverProfiles, buildManifest, saveManifest, loadManifest, ensureRootGitignore } from 'ccprofiles-core'
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CliContext } from '../context.js'

export function registerProfileCommands(program: Command, ctx: CliContext): void {
  program.command('list').description('list Claude Code profiles').action(async () => {
    const live = await discoverProfiles(ctx.home)
    const rows = live.map(lp => ({
      name: lp.dirName === '.claude' ? 'default' : lp.dirName.slice('.claude-'.length),
      dir: lp.dir,
      account: lp.account ?? '-',
      mcp: Object.keys(lp.mcpServers).length,
    }))
    for (const r of rows) console.log(`${r.name.padEnd(12)} ${String(r.mcp).padStart(3)} mcp  ${r.account.padEnd(28)} ${r.dir}`)
  })

  program.command('adopt').description('build manifest from live profiles')
    .option('--yes', 'write without confirmation')
    .action(async (opts: { yes?: boolean }) => {
      const live = await discoverProfiles(ctx.home)
      const manifest = buildManifest(live, ctx.platform)
      console.log(`Discovered ${manifest.profiles.length} profiles, ${Object.keys(manifest.mcpServers).length} mcp servers.`)
      if (!opts.yes) { console.log('Re-run with --yes to write the manifest.'); return }
      if (!existsSync(join(ctx.manifestRoot, '.git'))) {
        try { execFileSync('git', ['init', ctx.manifestRoot], { stdio: 'ignore' }) } catch { /* git optional */ }
      }
      await ensureRootGitignore(ctx.manifestRoot)
      await saveManifest(ctx.manifestRoot, manifest)
      console.log(`Manifest written to ${join(ctx.manifestRoot, 'manifest.yaml')}`)
    })

  program.command('doctor').description('check setup health').action(async () => {
    const problems: string[] = []
    const live = await discoverProfiles(ctx.home)
    for (const lp of live)
      for (const name of readdirSync(lp.dir)) {
        const f = join(lp.dir, name)
        try {
          if (lstatSync(f).isSymbolicLink() && !existsSync(f)) problems.push(`broken symlink: ${f} -> ${readlinkSync(f)}`)
        } catch { /* ignore */ }
      }
    if (existsSync(ctx.platform.rcFile)) {
      const rc = readFileSync(ctx.platform.rcFile, 'utf8')
      const outsideBlock = rc.split('# >>> ccprofiles managed >>>')[0] + (rc.split('# <<< ccprofiles managed <<<')[1] ?? '')
      if (/sk-ant-/.test(outsideBlock)) problems.push(`plaintext Anthropic key found in ${ctx.platform.rcFile} — run: ccprofiles secrets migrate`)
    }
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const m = await loadManifest(ctx.manifestRoot)
      for (const pr of m.profiles) {
        const dir = pr.dir.replace('{home}', ctx.home)
        if (!existsSync(dir)) problems.push(`manifest profile "${pr.name}" missing on disk: ${dir} — run: ccprofiles apply`)
      }
    }
    if (problems.length === 0) { console.log('ok: no problems found'); return }
    for (const p of problems) console.log(`warn: ${p}`)
    process.exitCode = 1
  })
}
