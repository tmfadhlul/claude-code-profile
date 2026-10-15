import {
  claudeMemCacheDirs, claudeMemManagedProfile, discoverProfiles, liveProfileName, loadManifest, pickClaudeMemAuth,
  readClaudeMemFiles, renderClaudeMemConfig, renderPath, writeClaudeMemFiles, type ClaudeMemCandidate,
} from 'ccprofiles-core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { secretsStore } from './secrets.js'
import { step } from '../progress.js'

const SECRET_PREFIX = 'secret://'

/**
 * Point claude-mem at working credentials: an OAuth profile if any, else a key profile's
 * credentials (see pickClaudeMemAuth / renderClaudeMemConfig in core). No-op when claude-mem
 * isn't installed. Returns what changed (or, with dryRun, what would); secrets are only read
 * from the store when a key profile is chosen and a real write follows.
 */
export async function syncClaudeMemAuth(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<{ changed: string[]; problem?: string }> {
  const live = (await discoverProfiles(ctx.home)).filter(l => l.agent === 'claude')
  const dataDir = join(ctx.home, '.claude-mem')
  const installed = existsSync(dataDir) || (await Promise.all(live.map(l => claudeMemCacheDirs(l.dir)))).some(d => d.length)
  if (!installed) return { changed: [] }
  step('Checking claude-mem credentials')

  const m = existsSync(join(ctx.manifestRoot, 'manifest.yaml')) ? await loadManifest(ctx.manifestRoot) : null
  const cands: ClaudeMemCandidate[] = live.map(lp => {
    const decl = m?.profiles.find(p => p.name === liveProfileName(lp) && renderPath(p.dir, ctx.platform) === lp.dir)
    // live settings.json env holds resolved values; the manifest adds launcher env (as refs)
    return { name: liveProfileName(lp), dir: lp.dir, oauth: !!lp.authenticated, env: { ...decl?.env, ...decl?.settingsEnv, ...lp.settingsEnv } }
  })
  const files = await readClaudeMemFiles(dataDir)
  const configured = typeof files.settings?.CLAUDE_MEM_CLAUDE_CONFIG_DIR === 'string' ? files.settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR : ''
  const defaultDir = join(ctx.home, '.claude')
  const auth = pickClaudeMemAuth(cands, { configDir: configured || defaultDir, profile: claudeMemManagedProfile(files.envText) })
  if (!auth) return { changed: [], problem: 'claude-mem: no profile has an OAuth login or an API key — it cannot record memories' }

  if (auth.kind !== 'oauth') {
    let store: Awaited<ReturnType<typeof secretsStore>> | null = null
    for (const [k, v] of Object.entries(auth.env)) {
      if (!v.startsWith(SECRET_PREFIX)) continue
      // dry-run (doctor) never touches the keychain: assume the value already in .env is current,
      // so an up-to-date setup doesn't read as a pending change
      if (opts.dryRun) { auth.env[k] = managedValue(files.envText, k) ?? 'x'; continue }
      store ??= await secretsStore(ctx)
      const val = await store.get(v.slice(SECRET_PREFIX.length))
      if (val === null) throw new Error(`claude-mem: secret not found: ${v} (${k} of profile "${auth.profile}")`)
      auth.env[k] = val
    }
  }
  const r = renderClaudeMemConfig(files, auth, defaultDir)
  if ('skip' in r || !r.changes.length) return { changed: [] }
  if (!opts.dryRun) await writeClaudeMemFiles(dataDir, files, r)
  const via = auth.kind === 'oauth' ? `OAuth of profile "${auth.profile}"` : `${auth.kind} of profile "${auth.profile}"`
  return { changed: [`claude-mem: ${opts.dryRun ? 'should use' : 'now uses'} ${via} (${r.changes.join(', ')})`] }
}

function managedValue(envText: string, key: string): string | undefined {
  return envText.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1)
}
