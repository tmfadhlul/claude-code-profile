import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRootGitignore } from '../src/devices.js'

describe('ensureRootGitignore', () => {
  it('keeps secret-bearing files (including Windows DPAPI ciphertext) out of the manifest repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-gitignore-'))
    await ensureRootGitignore(root)
    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('secrets.enc')
    expect(gitignore).toContain('secrets.dpapi.json')
  })
})
