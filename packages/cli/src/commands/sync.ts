import type { Command } from 'commander'
import {
  startSyncServer, pairWithServer, fetchRemote, fetchSecrets,
  loadDevices, saveDevices, parseManifest, serializeManifest, saveManifest,
  writeAssets, discoverProfiles, planApply, executeApply, backupFiles,
} from '@ccprofiles/core'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { secretsStore } from './secrets.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerSyncCommands(program: Command, ctx: CliContext): void {
  program.command('serve').description('serve this device for pairing/sync')
    .option('--port <n>', 'port (default: random)', v => parseInt(v, 10))
    .option('--allow-secrets', 'allow paired devices to pull secret values')
    .action(async (opts: { port?: number; allowSecrets?: boolean }) => {
      const server = await startSyncServer({
        manifestRoot: ctx.manifestRoot,
        platform: ctx.platform,
        port: opts.port,
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
      console.log(`ccprofiles sync server on port ${server.port}`)
      console.log(`pairing PIN: ${server.pin}`)
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
      if (!device) throw new Error(`unknown device: ${opts.from} — run: ccp pair <host> --port <p> --pin <pin>`)
      const { manifestYaml, assets } = await fetchRemote(device)
      const m = parseManifest(manifestYaml) // validate before touching anything
      console.log(`pulled manifest: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers, ${Object.keys(assets).length} asset files`)
      if (!opts.dryRun) {
        await backupFiles([join(ctx.manifestRoot, 'manifest.yaml')], ctx.backupRoot, stamp())
        await saveManifest(ctx.manifestRoot, m)
        await writeAssets(assets, m, ctx.platform)
      }
      const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
      if (opts.withSecrets) {
        const values = await fetchSecrets(device, [])
        if (!opts.dryRun) {
          const store = await secretsStore(ctx)
          for (const [k, v] of Object.entries(values)) await store.set(k, v)
        }
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}secrets transferred: ${Object.keys(values).join(', ') || 'none'}`)
      }
    })
}
