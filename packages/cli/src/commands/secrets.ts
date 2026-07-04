import type { Command } from 'commander'
import { SecretsStore, FileBackend, defaultBackend, backupFiles, atomicWrite } from 'ccprofiles-core'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { CliContext } from '../context.js'

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

const KEY_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
// posix: export VAR="sk-..."   powershell: $env:VAR = "sk-..."
const MIGRATE_RE_POSIX = new RegExp(`^(\\s*(?:export\\s+)?(${KEY_VARS.join('|')})\\s*=\\s*)"?(sk-[A-Za-z0-9_-]+)"?(.*)$`)
const MIGRATE_RE_PWSH = new RegExp(`^(\\s*\\$env:(${KEY_VARS.join('|')})\\s*=\\s*)"?(sk-[A-Za-z0-9_-]+)"?(.*)$`)

export function registerSecretsCommands(program: Command, ctx: CliContext): void {
  const sec = program.command('secrets').description('manage secrets (values never stored in configs)')

  sec.command('set <name> [value]').action(async (name: string, value?: string) => {
    if (value === undefined) throw new Error('value required (interactive prompt lands in Plan 2)')
    const store = await secretsStore(ctx)
    await store.set(name, value)
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
    const rcFile = ctx.platform.rcFile
    if (!existsSync(rcFile)) { console.log('no rc file found'); return }
    const store = await secretsStore(ctx)
    const lines = (await readFile(rcFile, 'utf8')).split('\n')
    const migrated: string[] = []
    const out = [] as string[]
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
    if (migrated.length === 0) { console.log('no plaintext keys found'); return }
    if (!opts.dryRun) {
      await backupFiles([rcFile], ctx.backupRoot, new Date().toISOString().replace(/[:.]/g, '-'))
      await atomicWrite(rcFile, out.join('\n'))
    }
    for (const n of migrated) console.log(`${opts.dryRun ? '[dry-run] ' : ''}migrated ${n}`)
  })
}
