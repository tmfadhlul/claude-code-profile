import { join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

export const IS_WIN = process.platform === 'win32'

/** The rc file makeContext will manage for a given test home (SHELL=/bin/zsh on posix). */
export function rcFileFor(home: string): string {
  return IS_WIN
    ? join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    : join(home, '.zshrc')
}

/** Platform-appropriate "plaintext key in rc file" line. */
export function envKeyLine(name: string, value: string): string {
  return IS_WIN ? `$env:${name} = "${value}"` : `export ${name}="${value}"`
}

/** What a migrated secret reference looks like on this platform. */
export function secretRef(name: string): string {
  return IS_WIN ? `(ccprofiles secrets get ${name})` : `$(ccprofiles secrets get ${name})`
}

export async function seedRc(home: string, content: string): Promise<string> {
  const rc = rcFileFor(home)
  await mkdir(dirname(rc), { recursive: true })
  await writeFile(rc, content)
  return rc
}
