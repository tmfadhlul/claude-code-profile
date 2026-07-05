import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerDef } from './manifest.js'

export interface LiveProfile {
  dirName: string
  dir: string
  configPath: string
  account: string | null
  mcpServers: Record<string, McpServerDef>
  links: Record<string, string>
  settingsEnv: Record<string, string>
}

export async function discoverProfiles(home: string): Promise<LiveProfile[]> {
  const entries = await readdir(home, { withFileTypes: true })
  const out: LiveProfile[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !(e.name === '.claude' || e.name.startsWith('.claude-'))) continue
    const dir = join(home, e.name)
    const configPath = e.name === '.claude' ? join(home, '.claude.json') : join(dir, '.claude.json')
    let cfg: any
    try { cfg = JSON.parse(await readFile(configPath, 'utf8')) } catch { continue }
    const links: Record<string, string> = {}
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (child.isSymbolicLink()) {
        try {
          // windows junctions read back as \\?\C:\... with a trailing separator — normalize
          links[child.name] = (await readlink(join(dir, child.name)))
            .replace(/^\\\\\?\\/, '').replace(/([\\/])+$/, '')
        } catch { /* skip */ }
      }
    }
    const settingsEnv: Record<string, string> = {}
    try {
      const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      if (s && typeof s.env === 'object' && s.env !== null)
        for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') settingsEnv[k] = v
    } catch { /* no settings.json */ }
    out.push({
      dirName: e.name,
      dir,
      configPath,
      account: cfg?.oauthAccount?.emailAddress ?? null,
      mcpServers: cfg?.mcpServers ?? {},
      links,
      settingsEnv,
    })
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName))
}
