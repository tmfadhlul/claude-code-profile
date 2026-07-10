import { copyFile, cp, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.ccp-tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

function sanitize(absPath: string): string {
  return absPath.replace(/:/g, '').replace(/[\\/]+/g, '__').replace(/^__/, '')
}

export async function backupFiles(files: string[], backupRoot: string, stamp: string): Promise<string> {
  const dir = join(backupRoot, stamp)
  await mkdir(dir, { recursive: true })
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
  await mkdir(dir, { recursive: true })
  await cp(src, dest, { recursive: true })
  return dest
}
