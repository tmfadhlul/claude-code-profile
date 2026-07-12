import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBackend, KeychainBackend, SecretsStore, DpapiBackend } from '../src/secrets.js'

describe('FileBackend', () => {
  it('round-trips and deletes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const b = new FileBackend(join(dir, 's.enc'), 'pw')
    await b.set('api-key', 'sk-ant-123')
    expect(await b.get('api-key')).toBe('sk-ant-123')
    await b.delete('api-key')
    expect(await b.get('api-key')).toBeNull()
  })
  it('writes the vault file with 0600 permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const b = new FileBackend(join(dir, 's.enc'), 'pw')
    await b.set('api-key', 'sk-ant-123')
    const st = await stat(join(dir, 's.enc'))
    expect(st.mode & 0o777).toBe(0o600)
  })
  it('fails closed on wrong passphrase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    await new FileBackend(join(dir, 's.enc'), 'right').set('k', 'v')
    await expect(new FileBackend(join(dir, 's.enc'), 'wrong').get('k')).rejects.toThrow()
  })
})

describe('KeychainBackend', () => {
  it('builds correct security invocations', async () => {
    const calls: string[][] = []
    const fakeExec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: 'v\n' } }
    const b = new KeychainBackend(fakeExec as any)
    await b.set('k', 'v')
    expect(calls[0]).toEqual(['security', 'add-generic-password', '-U', '-s', 'ccprofiles', '-a', 'k', '-w', 'v'])
    expect(await b.get('k')).toBe('v')
    expect(calls[1]).toEqual(['security', 'find-generic-password', '-s', 'ccprofiles', '-a', 'k', '-w'])
  })
})

describe('SecretsStore', () => {
  it('tracks names in index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const store = new SecretsStore(new FileBackend(join(dir, 's.enc'), 'pw'), join(dir, 'index.json'))
    await store.set('a', '1'); await store.set('b', '2'); await store.delete('a')
    expect(await store.list()).toEqual(['b'])
  })
  it('writes the name index with 0600 permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const store = new SecretsStore(new FileBackend(join(dir, 's.enc'), 'pw'), join(dir, 'index.json'))
    await store.set('a', '1')
    const st = await stat(join(dir, 'index.json'))
    expect(st.mode & 0o777).toBe(0o600)
  })
})

describe('DpapiBackend', () => {
  // Fake DPAPI: base64 round-trip stands in for real PowerShell/ProtectedData.
  const fakeCrypt = {
    protect: async (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
    unprotect: async (b64: string) => Buffer.from(b64, 'base64').toString('utf8'),
  }
  it('set/get/delete round-trips via the injected crypt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-dpapi-'))
    const b = new DpapiBackend(join(dir, 'secrets.dpapi.json'), fakeCrypt)
    expect(await b.get('missing')).toBeNull()
    await b.set('k', 'super-secret')
    expect(await b.get('k')).toBe('super-secret')
    await b.delete('k')
    expect(await b.get('k')).toBeNull()
  })
  it('persists ciphertext, not plaintext, on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-dpapi2-'))
    const file = join(dir, 'secrets.dpapi.json')
    await new DpapiBackend(file, fakeCrypt).set('k', 'plaintext-value')
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('plaintext-value')
  })
  it('writes the vault file with 0600 permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-dpapi3-'))
    const file = join(dir, 'secrets.dpapi.json')
    await new DpapiBackend(file, fakeCrypt).set('k', 'v')
    const st = await stat(file)
    expect(st.mode & 0o777).toBe(0o600)
  })
})
