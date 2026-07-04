import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBackend, KeychainBackend, SecretsStore } from '../src/secrets.js'

describe('FileBackend', () => {
  it('round-trips and deletes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const b = new FileBackend(join(dir, 's.enc'), 'pw')
    await b.set('api-key', 'sk-ant-123')
    expect(await b.get('api-key')).toBe('sk-ant-123')
    await b.delete('api-key')
    expect(await b.get('api-key')).toBeNull()
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
})
