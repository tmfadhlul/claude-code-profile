import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, backupFiles } from '../src/fsutil.js'

describe('fsutil', () => {
  it('atomicWrite writes content and leaves no tmp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const f = join(dir, 'a.json')
    await atomicWrite(f, '{"x":1}')
    expect(await readFile(f, 'utf8')).toBe('{"x":1}')
    expect((await readdir(dir)).filter(n => n.includes('ccp-tmp'))).toEqual([])
  })
  it('atomicWrite honors an explicit mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const f = join(dir, 'secret.json')
    await atomicWrite(f, '{"x":1}', { mode: 0o600 })
    const st = await stat(f)
    expect(st.mode & 0o777).toBe(0o600)
  })
  it('atomicWrite defaults to 0644 when no mode is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const f = join(dir, 'plain.json')
    await atomicWrite(f, '{"x":1}')
    const st = await stat(f)
    expect(st.mode & 0o777).toBe(0o644)
  })
  it('backupFiles copies existing, skips missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const src = join(dir, 'x.txt')
    await writeFile(src, 'hi')
    const backupDir = await backupFiles([src, join(dir, 'missing.txt')], join(dir, 'backups'), '2026-07-05T00-00-00')
    const copied = await readdir(backupDir)
    expect(copied).toHaveLength(1)
    expect(await readFile(join(backupDir, copied[0]), 'utf8')).toBe('hi')
  })
})
