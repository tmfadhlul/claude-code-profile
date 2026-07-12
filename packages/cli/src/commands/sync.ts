import type { Command } from 'commander'
import {
  startSyncServer, pairWithServer, fetchRemote, fetchSecrets,
  loadDevices, saveDevices, parseManifest, serializeManifest, saveManifest,
  writeAssets, executeApply, backupFiles,
} from 'ccprofiles-core'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { secretsStore } from './secrets.js'
import { reconcilePlugins } from './plugins.js'
import { planActions, planActionsPreflight } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerSyncCommands(program: Command, ctx: CliContext): void {
  program.command('serve').description('serve this device for pairing/sync')
    .option('--port <n>', 'port (default: random)', v => parseInt(v, 10))
    .option('--host <ip>', 'interface to bind (default: 0.0.0.0 — all interfaces; set your LAN IP to restrict)')
    .option('--allow-secrets', 'allow paired devices to pull secret values')
    .action(async (opts: { port?: number; host?: string; allowSecrets?: boolean }) => {
      const server = await startSyncServer({
        manifestRoot: ctx.manifestRoot,
        platform: ctx.platform,
        port: opts.port,
        host: opts.host,
        allowSecrets: opts.allowSecrets,
        secretValues: async names => {
          const store = await secretsStore(ctx)
          const wanted = names.length ? names : await store.list()
          const out: Record<string, string> = {}
          for (const n of wanted) {
            const v = await store.get(n)
            if (v !== null) out[n] = v
          }
          return out
        },
      })
      console.log(`ccprofiles sync server on ${server.host}:${server.port}`)
      if (server.host === '0.0.0.0') console.log('(reachable from all network interfaces — pass --host <lan-ip> to restrict)')
      console.log(`pairing PIN: ${server.pin}`)
      console.log('(pairing locks after 5 wrong PINs — restart serve to reset)')
      if (opts.allowSecrets) console.log('secrets transfer: ENABLED for paired devices')
      console.log('Ctrl-C to stop')
      await new Promise(() => { /* run until killed */ })
    })

  program.command('pair <host>').description('pair with a serving device')
    .requiredOption('--pin <pin>', 'PIN shown on the serving device')
    .requiredOption('--port <n>', 'port shown on the serving device', (v: string) => parseInt(v, 10))
    .option('--name <name>', 'name for this peer', undefined)
    .action(async (host: string, opts: { pin: string; port: number; name?: string }) => {
      const device = await pairWithServer(host, opts.port, opts.pin, opts.name ?? host)
      const devices = (await loadDevices(ctx.manifestRoot)).filter(d => d.name !== device.name)
      devices.push(device)
      await saveDevices(ctx.manifestRoot, devices)
      console.log(`paired with ${device.name} (${host}:${opts.port})`)
    })

  program.command('devices').description('list paired devices').action(async () => {
    for (const d of await loadDevices(ctx.manifestRoot)) console.log(`${d.name.padEnd(16)} ${d.host}:${d.port}`)
  })

  program.command('sync').description('pull manifest + assets from a paired device and apply')
    .requiredOption('--from <device>')
    .option('--with-secrets', 'also transfer secret values into the local store')
    .option('--dry-run')
    .action(async (opts: { from: string; withSecrets?: boolean; dryRun?: boolean }) => {
      const device = (await loadDevices(ctx.manifestRoot)).find(d => d.name === opts.from)
      if (!device) throw new Error(`unknown device: ${opts.from} — run: ccprofiles pair <host> --port <p> --pin <pin>`)
      const { manifestYaml, assets } = await fetchRemote(device)
      const m = parseManifest(manifestYaml) // validate before touching anything
      console.log(`pulled manifest: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers, ${Object.keys(assets).length} asset files`)

      // Fetch+store secrets BEFORE touching local state, so a preflight below that needs a
      // just-transferred secret succeeds instead of failing after the manifest is overwritten.
      let values: Record<string, string> = {}
      if (opts.withSecrets) {
        values = await fetchSecrets(device, [])
        if (!opts.dryRun) {
          const store = await secretsStore(ctx)
          for (const [k, v] of Object.entries(values)) await store.set(k, v)
        }
      }

      // Validate the pulled manifest resolves cleanly before saving/applying anything — abort
      // (propagating the Error) rather than leave the local manifest overwritten and broken.
      await planActionsPreflight(ctx, m)

      if (!opts.dryRun) {
        await backupFiles([join(ctx.manifestRoot, 'manifest.yaml')], ctx.backupRoot, stamp())
        await saveManifest(ctx.manifestRoot, m)
        await writeAssets(assets, m, ctx.platform, { backupRoot: ctx.backupRoot, stamp: stamp() })
      }
      const actions = await planActions(ctx, m)
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
      if (opts.withSecrets) {
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}secrets transferred: ${Object.keys(values).join(', ') || 'none'}`)
      }
      // The pulled manifest declares plugins, but apply never installs them — reconcile so the
      // peer's plugin state actually matches. Best-effort: a missing `claude` binary or network
      // failure shouldn't fail the sync that already landed.
      if (!opts.dryRun) {
        const claudeNames = m.profiles.filter(p => (p.agent ?? 'claude') === 'claude').map(p => p.name)
        try {
          for (const line of await reconcilePlugins(ctx, m, claudeNames)) console.log(line)
        } catch (e) {
          console.error(`warn: plugin reconcile failed (${(e as Error).message}) — run: clp plugins apply --all`)
        }
      }
    })
}
