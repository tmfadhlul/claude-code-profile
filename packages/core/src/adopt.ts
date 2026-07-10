import { liveProfileName, type LiveProfile } from './discovery.js'
import type { Manifest, ProfileDecl } from './manifest.js'
import { toTemplate, type Platform } from './platform.js'

export function buildManifest(live: LiveProfile[], platform: Platform): Manifest {
  const mcpServers: Manifest['mcpServers'] = {}
  for (const lp of live)
    for (const [name, def] of Object.entries(lp.mcpServers))
      mcpServers[name] ??= def

  const marketplaces: Manifest['marketplaces'] = {}
  for (const lp of live)
    for (const [name, def] of Object.entries(lp.marketplaces ?? {}))
      marketplaces[name] ??= def

  // hub = profile whose dir is the most common link target prefix
  const linkVotes = new Map<string, number>()
  for (const lp of live)
    for (const target of Object.values(lp.links)) {
      const owner = live.find(o => o !== lp && target.startsWith(o.dir))
      if (owner) linkVotes.set(owner.dirName, (linkVotes.get(owner.dirName) ?? 0) + 1)
    }
  const hubDirName = [...linkVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const hubLive = hubDirName ? live.find(lp => lp.dirName === hubDirName) : null
  const hub = hubLive ? liveProfileName(hubLive) : null

  const profiles: ProfileDecl[] = live.map(lp => {
    const name = liveProfileName(lp)
    const links: Record<string, string> = {}
    for (const [entry, target] of Object.entries(lp.links)) {
      const isHubLink = hubDirName && target.startsWith(live.find(o => o.dirName === hubDirName)!.dir)
      links[entry] = isHubLink ? 'hub' : toTemplate(target, platform)
    }
    return {
      agent: lp.agent,
      name,
      dir: toTemplate(lp.dir, platform),
      launcher: lp.dirName === '.claude' || lp.dirName === '.codex' ? null
        : lp.agent === 'codex' ? `cx-${lp.dirName.slice('.codex-'.length)}` : `cl-${name}`,
      auth: lp.account || lp.authenticated ? ('oauth' as const) : ('env' as const),
      env: {},
      links,
      mcp: Object.keys(lp.mcpServers).sort(),
      settingsEnv: lp.settingsEnv,
      skipPermissions: false,
      sharedSessions: false,
      plugins: Object.entries(lp.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k).sort(),
    }
  })

  return { version: 1, hub, profiles, mcpServers, marketplaces }
}

/**
 * Re-migrate secret refs after a snapshot/adopt rebuilds the manifest from live state.
 * Live settings.json holds resolved plaintext values, so a freshly built manifest would
 * re-leak a previously migrated token as plaintext. For each profile that existed before,
 * if the old manifest had a secret:// ref whose resolved value matches the newly-discovered
 * plaintext value, restore the ref instead of the plaintext.
 */
export async function preserveSecretRefs(
  newM: Manifest,
  oldM: Manifest,
  getSecret: (name: string) => Promise<string | null>,
): Promise<void> {
  for (const pr of newM.profiles) {
    const old = oldM.profiles.find(p => p.name === pr.name)
    if (!old) continue
    for (const [k, v] of Object.entries(old.settingsEnv ?? {})) {
      if (!v.startsWith('secret://')) continue
      const resolved = await getSecret(v.slice('secret://'.length))
      if (resolved !== null && pr.settingsEnv[k] === resolved) pr.settingsEnv[k] = v
    }
  }
}
