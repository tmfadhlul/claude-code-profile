import type { Command } from 'commander'
import { SecretsStore, FileBackend, defaultBackend, backupFiles, atomicWrite, loadManifest, saveManifest, executeApply } from 'ccprofiles-core'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../context.js'

/**
 * Real masked-input reader for `secrets set <name>` (no value given): reads raw keystrokes from
 * stdin without echoing them (like `sudo`/`ssh-keygen`'s password prompt), so the secret never
 * appears on-screen, in shell history, or in `ps`. Tests inject `ctx.promptSecret` instead —
 * there's no TTY in CI, and raw mode can't be exercised there anyway.
 */
export function readSecretMasked(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process
    stdout.write(label)
    let value = ''
    const wasRaw = stdin.isTTY ? stdin.isRaw : undefined
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const cleanup = (): void => {
      stdin.off('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case '\n': case '\r':
            cleanup()
            stdout.write('\n')
            resolve(value)
            return
          case '\x03': // Ctrl-C
            cleanup()
            stdout.write('\n')
            reject(new Error('aborted'))
            return
          case '\x7f': case '\b': // backspace / DEL
            value = value.slice(0, -1)
            break
          default:
            value += ch
        }
      }
    }
    stdin.on('data', onData)
  })
}

export async function secretsStore(ctx: CliContext): Promise<SecretsStore> {
  const pw = ctx.env.CCPROFILES_PASSPHRASE
  const backend = pw
    ? new FileBackend(ctx.secretsFilePath, pw)
    : await defaultBackend(ctx.platform, {
        filePath: ctx.secretsFilePath,
        passphrase: async () => { throw new Error('set CCPROFILES_PASSPHRASE for the encrypted-file backend') },
      })
  return new SecretsStore(backend, ctx.secretsIndexPath)
}

export const KEY_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
// posix: export VAR="sk-..."   powershell: $env:VAR = "sk-..."
const MIGRATE_RE_POSIX = new RegExp(`^(\\s*(?:export\\s+)?(${KEY_VARS.join('|')})\\s*=\\s*)"?(sk-[A-Za-z0-9_-]+)"?(.*)$`)
const MIGRATE_RE_PWSH = new RegExp(`^(\\s*\\$env:(${KEY_VARS.join('|')})\\s*=\\s*)"?(sk-[A-Za-z0-9_-]+)"?(.*)$`)

/** Move plaintext keys out of the shell rc file into the secrets store. Shared by the CLI and the UI API. */
export async function migrateRcSecrets(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const rcFile = ctx.platform.rcFile
  if (!existsSync(rcFile)) return []
  const store = await secretsStore(ctx)
  const lines = (await readFile(rcFile, 'utf8')).split('\n')
  const migrated: string[] = []
  const out: string[] = []
  for (const line of lines) {
    const pwsh = line.match(MIGRATE_RE_PWSH)
    const posix = pwsh ? null : line.match(MIGRATE_RE_POSIX)
    const match = pwsh ?? posix
    if (!match) { out.push(line); continue }
    const [, prefix, varName, secretValue, suffix] = match
    const secretName = varName.toLowerCase().replaceAll('_', '-')
    if (!opts.dryRun) await store.set(secretName, secretValue)
    out.push(pwsh
      ? `${prefix}(ccprofiles secrets get ${secretName})${suffix}`
      : `${prefix}"$(ccprofiles secrets get ${secretName})"${suffix}`)
    migrated.push(secretName)
  }
  if (migrated.length && !opts.dryRun) {
    await backupFiles([rcFile], ctx.backupRoot, new Date().toISOString().replace(/[:.]/g, '-'))
    await atomicWrite(rcFile, out.join('\n'))
  }
  return migrated
}

/** Move plaintext token values in manifest settingsEnv into the secrets store as secret:// refs. */
export async function migrateSettingsSecrets(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  if (!existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) return []
  const m = await loadManifest(ctx.manifestRoot)
  const store = await secretsStore(ctx)
  const migrated: string[] = []
  for (const pr of m.profiles) {
    for (const varName of KEY_VARS) {
      const v = pr.settingsEnv[varName]
      if (!v || v.startsWith('secret://')) continue
      const secretName = `${varName.toLowerCase().replaceAll('_', '-')}-${pr.name}`
      if (!opts.dryRun) await store.set(secretName, v)
      pr.settingsEnv[varName] = `secret://${secretName}`
      migrated.push(secretName)
    }
  }
  if (migrated.length && !opts.dryRun) await saveManifest(ctx.manifestRoot, m)
  return migrated
}

export function registerSecretsCommands(program: Command, ctx: CliContext): void {
  const sec = program.command('secrets').description('manage secrets (values never stored in configs)')

  sec.command('set <name> [value]').action(async (name: string, value?: string) => {
    let secretValue: string
    if (value === undefined) {
      const prompt = ctx.promptSecret ?? readSecretMasked
      secretValue = await prompt(`Enter value for ${name}: `)
    } else {
      // Argv values land in shell history and are visible to other processes via `ps` — still
      // honor the request (e.g. scripted/non-interactive use) but make the risk visible.
      process.stderr.write(`warning: passing a secret value as a command-line argument leaves it in shell history and process listings — omit the value to be prompted instead\n`)
      secretValue = value
    }
    const store = await secretsStore(ctx)
    await store.set(name, secretValue)
    console.log(`stored ${name} (${store.backendName})`)
  })

  sec.command('get <name>').action(async (name: string) => {
    const store = await secretsStore(ctx)
    const v = await store.get(name)
    if (v === null) { process.exitCode = 1; return }
    console.log(v)
  })

  sec.command('list').action(async () => {
    const store = await secretsStore(ctx)
    for (const n of await store.list()) console.log(`${n}  (${store.backendName})`)
  })

  sec.command('rm <name>').action(async (name: string) => {
    const store = await secretsStore(ctx)
    await store.delete(name)
    console.log(`removed ${name}`)
  })

  sec.command('migrate').option('--dry-run').action(async (opts: { dryRun?: boolean }) => {
    const migrated = [...await migrateRcSecrets(ctx, opts), ...await migrateSettingsSecrets(ctx, opts)]
    if (migrated.length === 0) { console.log('no plaintext keys found'); return }
    for (const n of migrated) console.log(`${opts.dryRun ? '[dry-run] ' : ''}migrated ${n}`)
    // Apply so the manifest's newly-minted secret:// refs are (re-)resolved and written back
    // out — dynamic import avoids a static circular import (plan.ts imports this module for secretsStore).
    if (!opts.dryRun && existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const { planActions } = await import('../plan.js')
      const m = await loadManifest(ctx.manifestRoot)
      const actions = await planActions(ctx, m)
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: new Date().toISOString().replace(/[:.]/g, '-') })
      for (const line of res.performed) console.log(`applied: ${line}`)
    }
  })
}
