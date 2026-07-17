import { access, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerDef } from './manifest.js'
import { readCodexMcpServers } from './codex.js'
import { logicalLinkEntry } from './links.js'

export interface LiveProfile {
  agent: 'claude' | 'codex'
  dirName: string
  dir: string
  configPath: string
  account: string | null
  authenticated?: boolean
  mcpServers: Record<string, McpServerDef>
  links: Record<string, string>
  settingsEnv: Record<string, string>
  enabledPlugins: Record<string, boolean>
  /** Plugin ids actually installed (keys of plugins/installed_plugins.json) — the ground truth
   *  for "present". enabledPlugins alone can be stale: an enabled-but-never-installed entry
   *  (e.g. written by the retired union-sharing feature) must still trigger an install. */
  installedPlugins: string[]
  /** Comparable installed version per plugin id — a release version where there is one, else the
   *  git sha (see readInstalledPluginVersions for why those are interchangeable here). Ids with no
   *  version at all are absent. Feeds cross-profile drift detection (planPluginVersionDrift). */
  installedPluginVersions: Record<string, string>
  marketplaces: Record<string, { source: string }>
}

/**
 * Pull a comparable installed version out of each entry of installed_plugins.json's `plugins` map.
 *
 * Real-world shapes to survive (all four seen on one machine):
 *  - the value is an ARRAY of install records (one per scope: user/project/local), not an object
 *  - a released plugin has a real `version` ('13.11.0') alongside a `gitCommitSha`; the two move
 *    together, so either identifies the code — but the version reads better in a warning
 *  - a plugin pinned by git sha rather than a release has no real version, and Claude Code spells
 *    that inconsistently: the literal 'unknown' in some releases, the SHORT sha in others, for the
 *    very same commit ('unknown' vs 'e14e8fe2c1fc', both with sha 'e14e8fe2c1fca591…')
 *  - so a short-sha `version` must not be compared against a full `gitCommitSha` either — same
 *    commit, different string
 *
 * Hence: use `version` only when it is a real version, i.e. not missing, not 'unknown', and not
 * merely a prefix of the entry's own sha. Otherwise use the full `gitCommitSha`, which is the one
 * canonical spelling every profile agrees on.
 *
 * ponytail: takes the first scope's version when a plugin is installed at several scopes at once.
 * Per-scope drift is a different (rarer) bug than the cross-profile drift this exists to catch;
 * widen to Record<id, Record<scope, version>> if that ever bites.
 */
export function readInstalledPluginVersions(plugins: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, entries] of Object.entries(plugins)) {
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      const { version, gitCommitSha } = (e ?? {}) as { version?: unknown; gitCommitSha?: unknown }
      const sha = typeof gitCommitSha === 'string' && gitCommitSha ? gitCommitSha : null
      const ver = typeof version === 'string' && version && version !== 'unknown' ? version : null
      const isShaSpelling = !!ver && !!sha && sha.startsWith(ver)
      const v = ver && !isShaSpelling ? ver : sha ?? ver
      if (v) { out[id] = v; break }
    }
  }
  return out
}

export async function discoverProfiles(home: string): Promise<LiveProfile[]> {
  const entries = await readdir(home, { withFileTypes: true })
  const out: LiveProfile[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const agent = e.name === '.claude' || e.name.startsWith('.claude-') ? 'claude'
      : e.name === '.codex' || e.name.startsWith('.codex-') ? 'codex'
      : null
    if (!agent) continue
    const dir = join(home, e.name)
    const configPath = agent === 'codex' ? join(dir, 'config.toml')
      : e.name === '.claude' ? join(home, '.claude.json') : join(dir, '.claude.json')
    let cfg: any
    if (agent === 'claude') {
      try { cfg = JSON.parse(await readFile(configPath, 'utf8')) } catch { continue }
    } else {
      let authenticated = false
      try { await access(configPath) } catch {
        try { await access(join(dir, 'auth.json')); authenticated = true } catch { continue }
      }
      try { await access(join(dir, 'auth.json')); authenticated = true } catch { /* config-only profile */ }
      cfg = {}
      cfg.authenticated = authenticated
    }
    const links: Record<string, string> = {}
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (child.isSymbolicLink()) {
        try {
          // windows junctions read back as \\?\C:\... with a trailing separator — normalize
          links[logicalLinkEntry(agent, child.name)] = (await readlink(join(dir, child.name)))
            .replace(/^\\\\\?\\/, '').replace(/([\\/])+$/, '')
        } catch { /* skip */ }
      }
    }
    const settingsEnv: Record<string, string> = {}
    const enabledPlugins: Record<string, boolean> = {}
    if (agent === 'claude') try {
      const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      if (s && typeof s.env === 'object' && s.env !== null)
        for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') settingsEnv[k] = v
      if (s && typeof s.enabledPlugins === 'object' && s.enabledPlugins !== null)
        for (const [k, v] of Object.entries(s.enabledPlugins)) if (typeof v === 'boolean') enabledPlugins[k] = v
    } catch { /* no settings.json */ }
    const marketplaces: Record<string, { source: string }> = {}
    if (agent === 'claude') try {
      const km = JSON.parse(await readFile(join(dir, 'plugins', 'known_marketplaces.json'), 'utf8'))
      if (km && typeof km === 'object') for (const [name, v] of Object.entries<any>(km)) {
        const repo = v?.source?.repo
        if (typeof repo === 'string') marketplaces[name] = { source: repo }
      }
    } catch { /* no plugins/known_marketplaces.json */ }
    const installedPlugins: string[] = []
    let installedPluginVersions: Record<string, string> = {}
    if (agent === 'claude') try {
      const ip = JSON.parse(await readFile(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'))
      if (ip && typeof ip.plugins === 'object' && ip.plugins !== null) {
        installedPlugins.push(...Object.keys(ip.plugins))
        installedPluginVersions = readInstalledPluginVersions(ip.plugins)
      }
    } catch { /* no plugins/installed_plugins.json */ }
    out.push({
      agent,
      dirName: e.name,
      dir,
      configPath,
      account: agent === 'claude' ? cfg?.oauthAccount?.emailAddress ?? null : null,
      authenticated: agent === 'codex' ? cfg.authenticated : !!cfg?.oauthAccount,
      mcpServers: agent === 'claude' ? cfg?.mcpServers ?? {} : await readCodexMcpServers(configPath),
      links,
      settingsEnv,
      enabledPlugins,
      installedPlugins,
      installedPluginVersions,
      marketplaces,
    })
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName))
}

export function liveProfileName(lp: Pick<LiveProfile, 'agent' | 'dirName'>): string {
  if (lp.agent === 'codex') return lp.dirName === '.codex' ? 'codex' : `codex-${lp.dirName.slice('.codex-'.length)}`
  return lp.dirName === '.claude' ? 'default' : lp.dirName.slice('.claude-'.length)
}
