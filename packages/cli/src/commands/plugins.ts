import type { Command } from 'commander'
import {
  discoverProfiles, saveManifest, reconcileProfilePlugins, restoreLegacyPluginSymlink,
  renderPath, type PluginRunner, type Manifest,
} from 'ccprofiles-core'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'

function claudeRunner(): PluginRunner {
  const run = (configDir: string, args: string[]) => new Promise<void>((resolve, reject) => {
    const p = spawn('claude', ['plugin', ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr?.on('data', d => { err += d })
    p.on('error', e => reject(new Error(`could not run 'claude' — is Claude Code on PATH? (${e.message})`)))
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `claude plugin ${args.join(' ')} exited ${code}`)))
  })
  return {
    // marketplace add tolerates an already-added marketplace (install will fail clearly if truly missing)
    marketplaceAdd: (cd, source) => run(cd, ['marketplace', 'add', source]).catch(() => {}),
    install: (cd, id) => run(cd, ['install', id]),
    uninstall: (cd, id) => run(cd, ['uninstall', id]),
  }
}

function targets(m: Manifest, opts: { profile?: string; all?: boolean }): string[] {
  if (opts.all) return m.profiles.filter(p => (p.agent ?? 'claude') === 'claude').map(p => p.name)
  if (!opts.profile) throw new Error('specify --profile <name> or --all')
  if (!m.profiles.some(p => p.name === opts.profile)) throw new Error(`unknown profile: ${opts.profile}`)
  return [opts.profile]
}

export function registerPluginCommands(program: Command, ctx: CliContext): void {
  const plugins = program.command('plugins').description('manage Claude Code plugins across profiles')

  async function reconcile(m: Manifest, names: string[]): Promise<void> {
    const runner = ctx.pluginRunner ?? claudeRunner()
    const live = await discoverProfiles(ctx.home)
    for (const name of names) {
      const pr = m.profiles.find(p => p.name === name)!
      if ((pr.agent ?? 'claude') !== 'claude') continue
      const dir = renderPath(pr.dir, ctx.platform)
      await restoreLegacyPluginSymlink(join(dir, 'plugins'))
      const lp = live.find(l => l.dir === dir)
      const current = Object.entries(lp?.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k)
      const log = await reconcileProfilePlugins({ configDir: dir, desired: pr.plugins, current, marketplaces: m.marketplaces, runner })
      for (const line of log) console.log(`${name}: ${line}`)
    }
  }

  plugins.command('list').action(async () => {
    const m = await requireManifest(ctx)
    const ids = [...new Set(m.profiles.flatMap(p => p.plugins))].sort()
    const claude = m.profiles.filter(p => (p.agent ?? 'claude') === 'claude')
    console.log(' '.repeat(28) + claude.map(p => p.name.padEnd(10)).join(''))
    for (const id of ids) console.log(id.padEnd(28) + claude.map(p => (p.plugins.includes(id) ? 'x' : '.').padEnd(10)).join(''))
  })

  plugins.command('add <id>')
    .option('--profile <p>').option('--all').option('--marketplace <source>')
    .action(async (id: string, opts: any) => {
      const m = await requireManifest(ctx)
      const at = id.lastIndexOf('@'); const mkt = at > 0 ? id.slice(at + 1) : ''
      if (!mkt) throw new Error(`plugin id must be name@marketplace: ${id}`)
      if (!m.marketplaces[mkt]) {
        if (!opts.marketplace) throw new Error(`unknown marketplace "${mkt}" — pass --marketplace <source> to define it`)
        m.marketplaces[mkt] = { source: opts.marketplace }
      }
      const names = targets(m, opts)
      for (const t of names) { const pr = m.profiles.find(p => p.name === t)!; if (!pr.plugins.includes(id)) pr.plugins.push(id) }
      await saveManifest(ctx.manifestRoot, m)
      await reconcile(m, names)
    })

  plugins.command('rm <id>')
    .option('--profile <p>').option('--all')
    .action(async (id: string, opts: any) => {
      const m = await requireManifest(ctx)
      const names = targets(m, opts)
      for (const t of names) { const pr = m.profiles.find(p => p.name === t)!; pr.plugins = pr.plugins.filter(x => x !== id) }
      if (!m.profiles.some(p => p.plugins.includes(id))) { const at = id.lastIndexOf('@'); const mkt = at > 0 ? id.slice(at + 1) : ''; if (mkt && !m.profiles.some(p => p.plugins.some(x => x.endsWith(`@${mkt}`)))) delete m.marketplaces[mkt] }
      await saveManifest(ctx.manifestRoot, m)
      await reconcile(m, names)
    })

  plugins.command('sync')
    .requiredOption('--from <p>').option('--to <csv>').option('--all')
    .action(async (opts: any) => {
      const m = await requireManifest(ctx)
      const src = m.profiles.find(p => p.name === opts.from)
      if (!src) throw new Error(`unknown profile: ${opts.from}`)
      const to = opts.all ? m.profiles.filter(p => p.name !== src.name && (p.agent ?? 'claude') === 'claude').map(p => p.name) : String(opts.to ?? '').split(',').filter(Boolean)
      if (!to.length) throw new Error('specify --to <p1,p2> or --all')
      for (const t of to) { const pr = m.profiles.find(p => p.name === t); if (!pr) throw new Error(`unknown profile: ${t}`); pr.plugins = [...src.plugins] }
      await saveManifest(ctx.manifestRoot, m)
      await reconcile(m, to)
    })
}
