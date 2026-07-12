import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomicWrite } from './fsutil.js'
import type { Platform } from './platform.js'

export interface SecretsBackend {
  readonly name: string
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type EncFile = { salt: string; entries: Record<string, { iv: string; tag: string; data: string }> }

export class FileBackend implements SecretsBackend {
  readonly name = 'encrypted-file'
  constructor(private filePath: string, private passphrase: string) {}

  private async load(): Promise<EncFile> {
    if (!existsSync(this.filePath)) return { salt: randomBytes(16).toString('base64'), entries: {} }
    return JSON.parse(await readFile(this.filePath, 'utf8'))
  }
  private key(salt: string): Buffer {
    return scryptSync(this.passphrase, Buffer.from(salt, 'base64'), 32)
  }
  async get(key: string): Promise<string | null> {
    const f = await this.load()
    const e = f.entries[key]
    if (!e) return null
    const d = createDecipheriv('aes-256-gcm', this.key(f.salt), Buffer.from(e.iv, 'base64'))
    d.setAuthTag(Buffer.from(e.tag, 'base64'))
    return d.update(Buffer.from(e.data, 'base64')).toString('utf8') + d.final('utf8') // throws on bad passphrase
  }
  async set(key: string, value: string): Promise<void> {
    const f = await this.load()
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key(f.salt), iv)
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()])
    f.entries[key] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
    await atomicWrite(this.filePath, JSON.stringify(f), { mode: 0o600 })
  }
  async delete(key: string): Promise<void> {
    const f = await this.load()
    delete f.entries[key]
    await atomicWrite(this.filePath, JSON.stringify(f), { mode: 0o600 })
  }
}

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>
const realExec: ExecFn = promisify(execFile) as unknown as ExecFn

export class KeychainBackend implements SecretsBackend {
  readonly name = 'macos-keychain'
  constructor(private exec: ExecFn = realExec) {}
  async set(key: string, value: string): Promise<void> {
    await this.exec('security', ['add-generic-password', '-U', '-s', 'ccprofiles', '-a', key, '-w', value])
  }
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec('security', ['find-generic-password', '-s', 'ccprofiles', '-a', key, '-w'])
      return stdout.replace(/\n$/, '')
    } catch { return null }
  }
  async delete(key: string): Promise<void> {
    try { await this.exec('security', ['delete-generic-password', '-s', 'ccprofiles', '-a', key]) } catch { /* absent */ }
  }
}

export class SecretToolBackend implements SecretsBackend {
  readonly name = 'libsecret'
  constructor(private exec: ExecFn = realExec) {}
  async set(key: string, value: string): Promise<void> {
    const child = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      const proc = child.spawn('secret-tool', ['store', '--label=ccprofiles', 'service', 'ccprofiles', 'key', key], { stdio: ['pipe', 'ignore', 'ignore'] })
      proc.on('error', reject)
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code}`))))
      proc.stdin.end(value)
    })
  }
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec('secret-tool', ['lookup', 'service', 'ccprofiles', 'key', key])
      return stdout
    } catch { return null }
  }
  async delete(key: string): Promise<void> {
    try { await this.exec('secret-tool', ['clear', 'service', 'ccprofiles', 'key', key]) } catch { /* absent */ }
  }
}

export type DpapiCrypt = { protect(plain: string): Promise<string>; unprotect(b64: string): Promise<string> }

// DPAPI via built-in PowerShell. Secret bytes travel through a spawn env var, never argv.
export const powershellDpapi: DpapiCrypt = {
  protect: (plain) => runDpapi(
    // [string] cast coerces a $null CCP_IN (empty env var) to '' before GetBytes, which
    // otherwise throws on $null. Only needed here — unprotect's CCP_IN is base64 ciphertext
    // and is never empty for a stored value.
    "$b=[Text.Encoding]::UTF8.GetBytes([string]$env:CCP_IN);" +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))",
    plain),
  unprotect: async (b64) => {
    // PS emits base64 of the *decrypted bytes* (not the decoded string) so runDpapi's
    // trim is always ASCII-safe and we never depend on the PowerShell console's
    // stdout encoding to round-trip arbitrary plaintext (e.g. non-ASCII, trailing whitespace).
    const out = await runDpapi(
      "$b=[Convert]::FromBase64String($env:CCP_IN);" +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
      b64)
    return Buffer.from(out, 'base64').toString('utf8')
  },
}

async function runDpapi(script: string, input: string): Promise<string> {
  const child = await import('node:child_process')
  return new Promise<string>((resolve, reject) => {
    const proc = child.spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security;' + script],
      { env: { ...process.env, CCP_IN: input }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', reject)
    proc.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell dpapi exited ${code}: ${err.trim()}`))))
  })
}

type DpapiFile = { entries: Record<string, string> } // key -> DPAPI ciphertext (base64)

export class DpapiBackend implements SecretsBackend {
  readonly name = 'windows-dpapi'
  constructor(private filePath: string, private crypt: DpapiCrypt = powershellDpapi) {}
  private async load(): Promise<DpapiFile> {
    if (!existsSync(this.filePath)) return { entries: {} }
    return JSON.parse(await readFile(this.filePath, 'utf8'))
  }
  async get(key: string): Promise<string | null> {
    const f = await this.load()
    const ct = f.entries[key]
    return ct === undefined ? null : this.crypt.unprotect(ct)
  }
  async set(key: string, value: string): Promise<void> {
    const f = await this.load()
    f.entries[key] = await this.crypt.protect(value)
    await atomicWrite(this.filePath, JSON.stringify(f), { mode: 0o600 })
  }
  async delete(key: string): Promise<void> {
    const f = await this.load()
    delete f.entries[key]
    await atomicWrite(this.filePath, JSON.stringify(f), { mode: 0o600 })
  }
}

export class SecretsStore {
  constructor(private backend: SecretsBackend, private indexPath: string) {}
  private async readIndex(): Promise<string[]> {
    if (!existsSync(this.indexPath)) return []
    return JSON.parse(await readFile(this.indexPath, 'utf8'))
  }
  private async writeIndex(names: string[]): Promise<void> {
    await atomicWrite(this.indexPath, JSON.stringify([...new Set(names)].sort()), { mode: 0o600 })
  }
  get backendName(): string { return this.backend.name }
  async get(key: string): Promise<string | null> { return this.backend.get(key) }
  async set(key: string, value: string): Promise<void> {
    await this.backend.set(key, value)
    await this.writeIndex([...(await this.readIndex()), key])
  }
  async delete(key: string): Promise<void> {
    await this.backend.delete(key)
    await this.writeIndex((await this.readIndex()).filter(n => n !== key))
  }
  async list(): Promise<string[]> { return this.readIndex() }
}

export async function defaultBackend(
  p: Platform,
  opts: { filePath: string; passphrase?: () => Promise<string> },
): Promise<SecretsBackend> {
  if (p.os === 'darwin') return new KeychainBackend()
  if (p.os === 'linux') {
    try { await realExec('secret-tool', ['--help']); return new SecretToolBackend() } catch { /* fall through */ }
  }
  if (p.os === 'win32') return new DpapiBackend(opts.filePath.replace(/\.enc$/, '.dpapi.json'))
  const pw = opts.passphrase ? await opts.passphrase() : ''
  if (!pw) throw new Error('encrypted-file backend requires a passphrase')
  return new FileBackend(opts.filePath, pw)
}
