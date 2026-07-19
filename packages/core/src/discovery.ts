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
 * ccprofiles manages a profile's USER-scope plugins. A project-scope install belongs to some project
 * directory, not to the profile, and `claude plugin update/uninstall` only ever act on user scope —
 * counting one made those calls fail with `Plugin "x" is not installed at scope user`. Entries
 * predating the `scope` field are treated as user.
 */
function userScopeEntries(entries: unknown): Array<{ version?: unknown; gitCommitSha?: unknown }> {
  return (Array.isArray(entries) ? entries : [entries])
    .filter((e: any) => e && (e.scope ?? 'user') === 'user')
}

/**
 * Pull a comparable installed version out of each entry of installed_plugins.json's `plugins` map.
 * The value is an ARRAY of install records (one per scope), not an object.
 *
 * ONLY a real release `version` counts. `gitCommitSha` looks like a tempting fallback for the
 * versionless plugins (Claude Code writes `"version": "unknown"` for those) but it is unusable as
 * an identity, and comparing it produced drift that `fix` could never clear:
 *  - it is the sha of the whole MARKETPLACE repo, not of the plugin — two profiles whose plugin
 *    files are byte-identical still hold different shas if they installed at different times
 *  - Claude Code never refreshes it when `claude plugin update` finds nothing to do, so the stale
 *    value outlives every update. Seen on a real machine: context7 at 205b6e0b in one profile and
 *    e14e8fe2 in three others, identical file contents, identical marketplace snapshot, and
 *    `clp fix` looping forever because update kept (correctly) no-opping.
 * A versionless plugin therefore contributes no drift signal at all. Detecting nothing beats
 * detecting noise that has no remedy.
 */
export function readInstalledPluginVersions(plugins: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, entries] of Object.entries(plugins)) {
    for (const { version } of userScopeEntries(entries)) {
      if (typeof version === 'string' && version && version !== 'unknown') { out[id] = version; break }
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
        installedPlugins.push(...Object.entries(ip.plugins).filter(([, v]) => userScopeEntries(v).length).map(([id]) => id))
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
