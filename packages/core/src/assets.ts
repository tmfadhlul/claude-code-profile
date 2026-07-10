import { lstat, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Manifest } from './manifest.js'
import { renderPath, type Platform } from './platform.js'
import { atomicWrite } from './fsutil.js'
import { physicalLinkEntry } from './links.js'

const HUB_DIRS = ['skills', 'commands', 'plugins']

function safeParts(rel: string): string[] {
  if (rel.includes('\\') || rel.includes('\0')) throw new Error(`unsafe asset path: ${JSON.stringify(rel)}`)
  const parts = rel.split('/')
  if (parts.some(x => !x || x === '.' || x === '..')) throw new Error(`unsafe asset path: ${JSON.stringify(rel)}`)
  return parts
}

async function assertNoSymlinkParents(root: string, segments: string[]): Promise<void> {
  let current = root
  for (const segment of ['', ...segments.slice(0, -1)]) {
    if (segment) current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`refusing to write asset through symlink: ${current}`)
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e
    }
  }
}

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
      const root = join(hubDir, physicalLinkEntry(hub.agent ?? 'claude', sub))
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
    const parts = safeParts(rel)
    if (parts[0] === 'hub' && hub) {
      const [, logicalEntry, ...rest] = parts
      if (!HUB_DIRS.includes(logicalEntry) || rest.length === 0) throw new Error(`unsafe asset path: ${JSON.stringify(rel)}`)
      const root = join(renderPath(hub.dir, p), physicalLinkEntry(hub.agent ?? 'claude', logicalEntry))
      await assertNoSymlinkParents(root, rest)
      await atomicWrite(join(root, ...rest), content)
    } else if (parts[0] === 'profiles') {
      const [, name, ...rest] = parts
      const pr = m.profiles.find(x => x.name === name)
      if (!pr) throw new Error(`asset references unknown profile: ${name}`)
      const guidanceName = (pr.agent ?? 'claude') === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'
      if (rest.length !== 1 || rest[0] !== guidanceName) throw new Error(`unsafe profile asset path: ${JSON.stringify(rel)}`)
      const root = renderPath(pr.dir, p)
      await assertNoSymlinkParents(root, rest)
      await atomicWrite(join(root, guidanceName), content)
    } else throw new Error(`unsafe asset path: ${JSON.stringify(rel)}`)
  }
}
