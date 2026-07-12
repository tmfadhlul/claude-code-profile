import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRootGitignore, saveDevices } from '../src/devices.js'

describe('ensureRootGitignore', () => {
  it('keeps secret-bearing files (including Windows DPAPI ciphertext) out of the manifest repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-gitignore-'))
    await ensureRootGitignore(root)
    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('secrets.enc')
    expect(gitignore).toContain('secrets.dpapi.json')
  })
})

describe('saveDevices', () => {
  it('writes devices.json with 0600 permissions (holds pairing key + token)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-devices-'))
    await saveDevices(root, [{ name: 'laptop', host: '127.0.0.1', port: 1234, token: 't', key: 'k' }])
    const st = await stat(join(root, 'devices.json'))
    expect(st.mode & 0o777).toBe(0o600)
  })
})
