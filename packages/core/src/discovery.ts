import { access, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerDef } from './manifest.js'
import { readCodexMcpServers } from './codex.js'

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
          links[child.name] = (await readlink(join(dir, child.name)))
            .replace(/^\\\\\?\\/, '').replace(/([\\/])+$/, '')
        } catch { /* skip */ }
      }
    }
    const settingsEnv: Record<string, string> = {}
    if (agent === 'claude') try {
      const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      if (s && typeof s.env === 'object' && s.env !== null)
        for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') settingsEnv[k] = v
    } catch { /* no settings.json */ }
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
    })
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName))
}

export function liveProfileName(lp: Pick<LiveProfile, 'agent' | 'dirName'>): string {
  if (lp.agent === 'codex') return lp.dirName === '.codex' ? 'codex' : `codex-${lp.dirName.slice('.codex-'.length)}`
  return lp.dirName === '.claude' ? 'default' : lp.dirName.slice('.claude-'.length)
}
