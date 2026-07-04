import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManifest, serializeManifest, loadManifest, saveManifest, ManifestError } from '../src/manifest.js'

const sample = {
  version: 1 as const,
  hub: 'default',
  profiles: [{
    name: 'oauth', dir: '{home}/.claude-oauth', launcher: 'cl-auth',
    auth: 'oauth' as const, env: {}, links: { skills: 'hub', commands: 'hub' }, mcp: ['playwright'],
  }],
  mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
}

describe('manifest', () => {
  it('round-trips through yaml', () => {
    expect(parseManifest(serializeManifest(sample))).toEqual(sample)
  })
  it('rejects unknown version', () => {
    expect(() => parseManifest('version: 2\nhub: null\nprofiles: []\nmcpServers: {}')).toThrow(ManifestError)
  })
  it('rejects profile referencing undefined mcp server', () => {
    const bad = { ...sample, mcpServers: {} }
    expect(() => parseManifest(serializeManifest(bad))).toThrow(/undefined mcp server/i)
  })
  it('loads and saves from a root dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-'))
    await saveManifest(root, sample)
    expect(await loadManifest(root)).toEqual(sample)
  })
})
