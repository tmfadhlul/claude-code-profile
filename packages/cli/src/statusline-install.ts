import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_STATUS_LINE, atomicWrite, backupFiles, type Manifest } from 'ccprofiles-core'

/** New CLI defaults without changing buildManifest behavior for older CLI releases. */
export function ensureManifestStatusline(manifest: Manifest, previous?: Manifest): void {
  manifest.statusLine ??= previous?.statusLine ?? DEFAULT_STATUS_LINE
}

/** Install default in existing Claude homes and ~/.claude, preserving every custom line. */
export async function installDefaultStatusline(home: string): Promise<string[]> {
  const entries = await readdir(home, { withFileTypes: true })
  const names = ['.claude', ...entries
    .filter(e => e.isDirectory() && e.name.startsWith('.claude-') &&
      (existsSync(join(home, e.name, '.claude.json')) || existsSync(join(home, e.name, 'settings.json'))))
    .map(e => e.name)]
  const changed: string[] = []
  for (const name of new Set(names)) {
    const path = join(home, name, 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings must be an object')
      settings = raw as Record<string, unknown>
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`)
    }
    if (Object.hasOwn(settings, 'statusLine')) continue
    await backupFiles([path], join(home, '.ccprofiles', 'backups'), new Date().toISOString().replace(/[:.]/g, '-'))
    await atomicWrite(path, JSON.stringify({ ...settings, statusLine: DEFAULT_STATUS_LINE }, null, 2) + '\n', { mode: 0o600 })
    changed.push(path)
  }
  return changed
}
