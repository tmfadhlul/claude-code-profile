import { Command } from 'commander'
import { detectPlatform, loadManifest, type Manifest, type Platform } from 'ccprofiles-core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerProfileCommands } from './commands/profiles.js'
import { registerMcpCommands } from './commands/mcp.js'
import { registerSecretsCommands } from './commands/secrets.js'
import { registerManifestCommands } from './commands/manifest.js'
import { registerSyncCommands } from './commands/sync.js'
import { registerBundleCommands } from './commands/bundle.js'

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
  const platform = detectPlatform(testHome ? { home: testHome, shell: env.SHELL } : {})
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
    throw new Error('no manifest yet — run: ccp adopt --yes  (builds one from your existing .claude* profiles)')
  }
  return loadManifest(ctx.manifestRoot)
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('ccp').description('Claude Code profile manager')
  program.exitOverride() // throw instead of process.exit — required for tests
  registerProfileCommands(program, ctx)
  registerMcpCommands(program, ctx)
  registerSecretsCommands(program, ctx)
  registerManifestCommands(program, ctx)
  registerSyncCommands(program, ctx)
  registerBundleCommands(program, ctx)
  return program
}
