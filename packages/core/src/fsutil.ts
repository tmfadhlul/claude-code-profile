import { chmod, copyFile, cp, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export async function atomicWrite(filePath: string, content: string, opts?: { mode?: number }): Promise<void> {
  // Secret-bearing writes (opts.mode set) also lock down the containing dir — it may be
  // manifestRoot itself if this is the first file ever written there (e.g. `secrets set`
  // before `adopt`/`manifest init` has created it).
  await mkdir(dirname(filePath), opts?.mode ? { recursive: true, mode: 0o700 } : { recursive: true })
  const tmp = `${filePath}.ccp-tmp`
  const mode = opts?.mode ?? 0o644
  await writeFile(tmp, content, { encoding: 'utf8', mode })
  await rename(tmp, filePath)
  // rename preserves the temp file's mode, but chmod explicitly to sidestep umask surprises.
  await chmod(filePath, mode)
}

function sanitize(absPath: string): string {
  return absPath.replace(/:/g, '').replace(/[\\/]+/g, '__').replace(/^__/, '')
}

export async function backupFiles(files: string[], backupRoot: string, stamp: string): Promise<string> {
  const dir = join(backupRoot, stamp)
  // Backups can contain copies of secret-bearing files (e.g. settings.json with resolved
  // tokens) — keep the backup dir as locked down as the originals.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const f of files) {
    if (!existsSync(f)) continue
    await copyFile(f, join(dir, sanitize(f)))
  }
  return dir
}

export async function backupTree(src: string, backupRoot: string, stamp: string): Promise<string | null> {
  if (!existsSync(src)) return null
  const dir = join(backupRoot, stamp)
  const dest = join(dir, sanitize(src))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await cp(src, dest, { recursive: true })
  return dest
}
