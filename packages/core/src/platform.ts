import os from 'node:os'
import path from 'node:path'

export type OsKind = 'darwin' | 'linux' | 'win32'
export interface Platform { os: OsKind; home: string; rcFile: string }

export function detectPlatform(opts: { osKind?: OsKind; home?: string; shell?: string } = {}): Platform {
  const osKind = opts.osKind ?? (process.platform as OsKind)
  const home = opts.home ?? os.homedir()
  const shell = opts.shell ?? process.env.SHELL ?? ''
  const rcFile = osKind === 'win32'
    ? path.win32.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    : path.posix.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bashrc')
  return { os: osKind, home, rcFile }
}

export function renderPath(template: string, p: Platform): string {
  const raw = template.replaceAll('{home}', p.home)
  return p.os === 'win32' ? raw.replaceAll('/', '\\') : raw
}

export function toTemplate(absPath: string, p: Platform): string {
  const norm = absPath.replaceAll('\\', '/')
  const home = p.home.replaceAll('\\', '/')
  // require a path-separator boundary — a raw startsWith would also match sibling dirs
  // that merely share a string prefix with home (e.g. home "/Users/tm" matching
  // "/Users/tmfadhlul-old/...")
  if (norm === home) return '{home}'
  if (norm.startsWith(home + '/')) return '{home}' + norm.slice(home.length)
  return norm
}
