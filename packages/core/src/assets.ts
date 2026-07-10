import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Manifest } from './manifest.js'
import { renderPath, type Platform } from './platform.js'
import { atomicWrite } from './fsutil.js'

const HUB_DIRS = ['skills', 'commands', 'plugins']

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) out.push(...await walk(p))
    else out.push(p)
  }
  return out
}

/** Collect shareable assets as a relative-path → utf8-content map. */
export async function collectAssets(m: Manifest, p: Platform): Promise<Record<string, string>> {
  const assets: Record<string, string> = {}
  const hub = m.profiles.find(x => x.name === m.hub)
  if (hub) {
    const hubDir = renderPath(hub.dir, p)
    for (const sub of HUB_DIRS) {
      const root = join(hubDir, sub)
      if (!existsSync(root)) continue
      for (const f of await walk(root)) {
        assets[`hub/${sub}/${relative(root, f).split('\\').join('/')}`] = await readFile(f, 'utf8')
      }
    }
  }
  for (const pr of m.profiles) {
    const guidanceName = (pr.agent ?? 'claude') === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'
    const guidance = join(renderPath(pr.dir, p), guidanceName)
    if (existsSync(guidance)) assets[`profiles/${pr.name}/${guidanceName}`] = await readFile(guidance, 'utf8')
  }
  return assets
}

/** Write an asset map back to the live layout. */
export async function writeAssets(assets: Record<string, string>, m: Manifest, p: Platform): Promise<void> {
  const hub = m.profiles.find(x => x.name === m.hub)
  for (const [rel, content] of Object.entries(assets)) {
    if (rel.startsWith('hub/') && hub) {
      await atomicWrite(join(renderPath(hub.dir, p), rel.slice('hub/'.length)), content)
    } else if (rel.startsWith('profiles/')) {
      const [, name, ...rest] = rel.split('/')
      const pr = m.profiles.find(x => x.name === name)
      if (pr) await atomicWrite(join(renderPath(pr.dir, p), rest.join('/')), content)
    }
  }
}
