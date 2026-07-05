import { Command } from 'commander'
import { detectPlatform, loadManifest, type Manifest, type OsKind, type Platform } from 'ccprofiles-core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerProfileCommands } from './commands/profiles.js'
import { registerMcpCommands } from './commands/mcp.js'
import { registerSecretsCommands } from './commands/secrets.js'
import { registerManifestCommands } from './commands/manifest.js'
import { registerSyncCommands } from './commands/sync.js'
import { registerBundleCommands } from './commands/bundle.js'
import { registerUiCommand } from './ui/command.js'

export interface CliContext {
  home: string
  platform: Platform
  manifestRoot: string
  secretsIndexPath: string
  secretsFilePath: string
  backupRoot: string
  env: NodeJS.ProcessEnv
}

export function makeContext(env: NodeJS.ProcessEnv = process.env): CliContext {
  const testHome = env.CCPROFILES_TEST_HOME
  // CCPROFILES_FORCE_OS is a test-only seam for simulating other platforms' secrets-backend
  // selection from a single dev machine — never set this outside tests. It intentionally
  // accepts any sentinel string (not just OsKind): detectPlatform/defaultBackend only ever
  // compare it against 'darwin'/'linux'/'win32' at runtime, so a value like 'none' safely
  // flows through as a deterministic "none of the above" platform for tests. Gated behind
  // CCPROFILES_TEST_HOME (the existing test-only signal) so it can never affect production.
  const forcedOs = testHome ? env.CCPROFILES_FORCE_OS : undefined
  const platform = detectPlatform({
    ...(testHome ? { home: testHome, shell: env.SHELL } : {}),
    ...(forcedOs ? { osKind: forcedOs as OsKind } : {}),
  })
  const manifestRoot = env.CCPROFILES_HOME ?? join(platform.home, '.ccprofiles')
  return {
    home: platform.home,
    platform,
    manifestRoot,
    secretsIndexPath: join(manifestRoot, 'secret-names.json'),
    secretsFilePath: join(manifestRoot, 'secrets.enc'),
    backupRoot: join(manifestRoot, 'backups'),
    env,
  }
}

/** Load the manifest, or explain how to create one — never a raw ENOENT. */
export async function requireManifest(ctx: CliContext): Promise<Manifest> {
  if (!existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
    throw new Error('no manifest yet — run: ccprofiles adopt --yes  (builds one from your existing .claude* profiles)')
  }
  return loadManifest(ctx.manifestRoot)
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('ccprofiles').description('Manage multiple Claude Code accounts/profiles (alias: clp)')
  program.exitOverride() // throw instead of process.exit — required for tests
  registerProfileCommands(program, ctx)
  registerMcpCommands(program, ctx)
  registerSecretsCommands(program, ctx)
  registerManifestCommands(program, ctx)
  registerSyncCommands(program, ctx)
  registerBundleCommands(program, ctx)
  registerUiCommand(program, ctx)
  return program
}
