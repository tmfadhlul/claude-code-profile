import type { LiveProfile } from './discovery.js'
import type { Manifest, ProfileDecl } from './manifest.js'
import { toTemplate, type Platform } from './platform.js'

function profileName(dirName: string): string {
  return dirName === '.claude' ? 'default' : dirName.slice('.claude-'.length)
}

export function buildManifest(live: LiveProfile[], platform: Platform): Manifest {
  const mcpServers: Manifest['mcpServers'] = {}
  for (const lp of live)
    for (const [name, def] of Object.entries(lp.mcpServers))
      mcpServers[name] ??= def

  // hub = profile whose dir is the most common link target prefix
  const linkVotes = new Map<string, number>()
  for (const lp of live)
    for (const target of Object.values(lp.links)) {
      const owner = live.find(o => o !== lp && target.startsWith(o.dir))
      if (owner) linkVotes.set(owner.dirName, (linkVotes.get(owner.dirName) ?? 0) + 1)
    }
  const hubDirName = [...linkVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const hub = hubDirName ? profileName(hubDirName) : null

  const profiles: ProfileDecl[] = live.map(lp => {
    const name = profileName(lp.dirName)
    const links: Record<string, string> = {}
    for (const [entry, target] of Object.entries(lp.links)) {
      const isHubLink = hubDirName && target.startsWith(live.find(o => o.dirName === hubDirName)!.dir)
      links[entry] = isHubLink ? 'hub' : toTemplate(target, platform)
    }
    return {
      name,
      dir: toTemplate(lp.dir, platform),
      launcher: name === 'default' ? null : `cl-${name}`,
      auth: lp.account ? ('oauth' as const) : ('env' as const),
      env: {},
      links,
      mcp: Object.keys(lp.mcpServers).sort(),
      settingsEnv: {},
    }
  })

  return { version: 1, hub, profiles, mcpServers }
}
