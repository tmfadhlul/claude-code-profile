import type { Command } from 'commander'
import {
  discoverProfiles, loadManifest, saveManifest, planApply, executeApply, type Manifest,
} from '@ccprofiles/core'
import type { CliContext } from '../context.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

async function applyNow(ctx: CliContext, m: Manifest, dryRun: boolean): Promise<void> {
  const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
  const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun })
  for (const line of res.performed) console.log(`${dryRun ? '[dry-run] ' : ''}${line}`)
}

function targets(m: Manifest, opts: { profile?: string; all?: boolean }): string[] {
  if (opts.all) return m.profiles.map(p => p.name)
  if (!opts.profile) throw new Error('specify --profile <name> or --all')
  if (!m.profiles.some(p => p.name === opts.profile)) throw new Error(`unknown profile: ${opts.profile}`)
  return [opts.profile]
}

export function registerMcpCommands(program: Command, ctx: CliContext): void {
  const mcp = program.command('mcp').description('manage MCP servers across profiles')

  mcp.command('list').action(async () => {
    const m = await loadManifest(ctx.manifestRoot)
    const names = Object.keys(m.mcpServers).sort()
    const header = ' '.repeat(24) + m.profiles.map(p => p.name.padEnd(10)).join('')
    console.log(header)
    for (const n of names) {
      const cells = m.profiles.map(p => (p.mcp.includes(n) ? 'x' : '.').padEnd(10)).join('')
      console.log(n.padEnd(24) + cells)
    }
  })

  mcp.command('add <name>')
    .option('--profile <p>').option('--all').option('--dry-run')
    .option('--command <cmd>').option('--args <csv>')
    .action(async (name: string, opts: any) => {
      const m = await loadManifest(ctx.manifestRoot)
      if (!m.mcpServers[name]) {
        if (!opts.command) throw new Error(`unknown server "${name}" — pass --command (and optionally --args) to define it`)
        m.mcpServers[name] = { command: opts.command, ...(opts.args ? { args: String(opts.args).split(',') } : {}) }
      }
      for (const t of targets(m, opts)) {
        const pr = m.profiles.find(p => p.name === t)!
        if (!pr.mcp.includes(name)) pr.mcp.push(name)
      }
      if (!opts.dryRun) await saveManifest(ctx.manifestRoot, m)
      await applyNow(ctx, m, !!opts.dryRun)
    })

  mcp.command('rm <name>')
    .option('--profile <p>').option('--all').option('--dry-run')
    .action(async (name: string, opts: any) => {
      const m = await loadManifest(ctx.manifestRoot)
      for (const t of targets(m, opts)) {
        const pr = m.profiles.find(p => p.name === t)!
        pr.mcp = pr.mcp.filter(x => x !== name)
      }
      if (!m.profiles.some(p => p.mcp.includes(name))) delete m.mcpServers[name]
      if (!opts.dryRun) await saveManifest(ctx.manifestRoot, m)
      await applyNow(ctx, m, !!opts.dryRun)
    })

  mcp.command('sync')
    .requiredOption('--from <p>').option('--to <csv>').option('--all').option('--dry-run')
    .action(async (opts: any) => {
      const m = await loadManifest(ctx.manifestRoot)
      const src = m.profiles.find(p => p.name === opts.from)
      if (!src) throw new Error(`unknown profile: ${opts.from}`)
      const to = opts.all
        ? m.profiles.filter(p => p.name !== src.name).map(p => p.name)
        : String(opts.to ?? '').split(',').filter(Boolean)
      if (to.length === 0) throw new Error('specify --to <p1,p2> or --all')
      for (const t of to) {
        const pr = m.profiles.find(p => p.name === t)
        if (!pr) throw new Error(`unknown profile: ${t}`)
        pr.mcp = [...src.mcp]
      }
      if (!opts.dryRun) await saveManifest(ctx.manifestRoot, m)
      await applyNow(ctx, m, !!opts.dryRun)
    })
}
