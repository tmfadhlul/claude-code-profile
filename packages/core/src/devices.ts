import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './fsutil.js'

export interface DeviceEntry {
  name: string
  host: string
  port: number
  token: string
  /** base64 pairing key — encrypts all traffic with this peer */
  key: string
}

const IGNORE = ['secrets.enc', 'secrets.dpapi.json', 'secret-names.json', 'devices.json', 'backups/', '*.ccp-tmp']

export async function loadDevices(root: string): Promise<DeviceEntry[]> {
  const f = join(root, 'devices.json')
  if (!existsSync(f)) return []
  return JSON.parse(await readFile(f, 'utf8'))
}

export async function saveDevices(root: string, list: DeviceEntry[]): Promise<void> {
  await atomicWrite(join(root, 'devices.json'), JSON.stringify(list, null, 2))
}

/** Keep secret-bearing files out of the manifest repo's auto-commits. */
export async function ensureRootGitignore(root: string): Promise<void> {
  const f = join(root, '.gitignore')
  const current = existsSync(f) ? await readFile(f, 'utf8') : ''
  const missing = IGNORE.filter(l => !current.split('\n').includes(l))
  if (missing.length) await atomicWrite(f, current + (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
}
