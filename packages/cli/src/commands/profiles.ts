import type { Command } from 'commander'
import { discoverProfiles, liveProfileName, buildManifest, saveManifest, loadManifest, preserveSecretRefs, ensureRootGitignore } from 'ccprofiles-core'
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CliContext } from '../context.js'
import { KEY_VARS, secretsStore } from './secrets.js'

export function registerProfileCommands(program: Command, ctx: CliContext): void {
  program.command('list').description('list Claude Code and Codex profiles').action(async () => {
    const live = await discoverProfiles(ctx.home)
    const rows = live.map(lp => ({
      name: liveProfileName(lp),
      agent: lp.agent,
      dir: lp.dir,
      account: lp.account ?? '-',
      mcp: Object.keys(lp.mcpServers).length,
    }))
    for (const r of rows) console.log(`${r.name.padEnd(16)} ${r.agent.padEnd(6)} ${String(r.mcp).padStart(3)} mcp  ${r.account.padEnd(28)} ${r.dir}`)
  })

  program.command('adopt').description('build manifest from live profiles')
    .option('--yes', 'write without confirmation')
    .action(async (opts: { yes?: boolean }) => {
      const live = await discoverProfiles(ctx.home)
      const manifest = buildManifest(live, ctx.platform)
      console.log(`Discovered ${manifest.profiles.length} profiles, ${Object.keys(manifest.mcpServers).length} mcp servers.`)
      if (!opts.yes) { console.log('Re-run with --yes to write the manifest.'); return }
      if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
        const oldM = await loadManifest(ctx.manifestRoot)
        let store: Awaited<ReturnType<typeof secretsStore>> | null = null
        await preserveSecretRefs(manifest, oldM, async name => { store ??= await secretsStore(ctx); return store.get(name) })
      }
      // git init pre-creates manifestRoot at 0755 if it doesn't exist yet, and a later
      // mkdir(root,{mode:0700}) is a no-op on an existing dir — so lock it down first.
      if (!existsSync(ctx.manifestRoot)) mkdirSync(ctx.manifestRoot, { recursive: true, mode: 0o700 })
      else if (process.platform !== 'win32') chmodSync(ctx.manifestRoot, 0o700)
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
    let m: Awaited<ReturnType<typeof loadManifest>> | null = null
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) m = await loadManifest(ctx.manifestRoot)
    for (const lp of live) {
      for (const name of readdirSync(lp.dir)) {
        const f = join(lp.dir, name)
        try {
          if (lstatSync(f).isSymbolicLink() && !existsSync(f)) problems.push(`broken symlink: ${f} -> ${readlinkSync(f)}`)
        } catch { /* ignore */ }
      }
      const pname = liveProfileName(lp)
      const decl = m?.profiles.find(p => p.name === pname) ?? null
      for (const varName of lp.agent === 'claude' ? KEY_VARS : []) {
        if (lp.settingsEnv[varName] && !decl?.settingsEnv[varName])
          problems.push(`plaintext token ${varName} in ${join(lp.dir, 'settings.json')} — adopt profile then run: secrets migrate`)
        if (decl?.settingsEnv[varName] && !decl.settingsEnv[varName].startsWith('secret://'))
          problems.push(`plaintext token ${varName} in manifest for profile "${pname}" — run: secrets migrate`)
      }
    }
    if (existsSync(ctx.platform.rcFile)) {
      const rc = readFileSync(ctx.platform.rcFile, 'utf8')
      const outsideBlock = rc.split('# >>> ccprofiles managed >>>')[0] + (rc.split('# <<< ccprofiles managed <<<')[1] ?? '')
      if (/sk-ant-/.test(outsideBlock)) problems.push(`plaintext Anthropic key found in ${ctx.platform.rcFile} — run: ccprofiles secrets migrate`)
    }
    if (m) for (const pr of m.profiles) {
      const dir = pr.dir.replace('{home}', ctx.home)
      if (!existsSync(dir)) problems.push(`manifest profile "${pr.name}" missing on disk: ${dir} — run: ccprofiles apply`)
    }
    if (existsSync(join(ctx.manifestRoot, '.git'))) {
      try {
        const remotes = execFileSync('git', ['-C', ctx.manifestRoot, 'remote'], { encoding: 'utf8' }).trim()
        if (remotes) problems.push(`${ctx.manifestRoot} has a git remote configured (${remotes.split('\n').join(', ')}) — manifest/secrets history could be pushed off this machine; run: git -C ${ctx.manifestRoot} remote remove <name>`)
      } catch { /* git optional */ }
    }
    if (problems.length === 0) { console.log('ok: no problems found'); return }
    for (const p of problems) console.log(`warn: ${p}`)
    process.exitCode = 1
  })
}
