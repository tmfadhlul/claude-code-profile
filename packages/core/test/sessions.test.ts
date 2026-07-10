import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessions } from '../src/sessions.js'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-sess-')) })

describe('scanSessions', () => {
  it('reads pool sessions with parsed metadata', async () => {
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const pdir = join(sharedRoot, 'projects', 'encoded-proj')
    await mkdir(pdir, { recursive: true })
    await writeFile(join(pdir, 'aaaaaaaa-0000.jsonl'),
      '{"type":"user","cwd":"/tmp/proj","gitBranch":"main","message":{"content":"hello world"}}\n' +
      '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}]}}\n')

    const rows = await scanSessions({ sharedRoot, profiles: [] })
    expect(rows.length).toBe(1)
    expect(rows[0].scope).toBe('shared')
    expect(rows[0].project).toBe('/tmp/proj')
    expect(rows[0].sessions[0].firstPrompt).toBe('hello world')
    expect(rows[0].sessions[0].messageCount).toBe(2)
    expect(rows[0].sessions[0].model).toBe('claude-opus-4-8')
    expect(rows[0].sessions[0].gitBranch).toBe('main')
  })

  it('scopes an isolated profile by name and skips symlinked projects/', async () => {
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    // isolated profile with a real projects dir
    const iso = join(home, '.claude-work')
    await mkdir(join(iso, 'projects', 'p'), { recursive: true })
    await writeFile(join(iso, 'projects', 'p', 's.jsonl'), '{"type":"user","cwd":"/w","message":{"content":"x"}}\n')
    // shared profile whose projects/ is a symlink -> should be skipped (shows under 'shared')
    const shared = join(home, '.claude')
    await mkdir(join(sharedRoot, 'projects'), { recursive: true })
    await mkdir(shared, { recursive: true })
    await symlink(join(sharedRoot, 'projects'), join(shared, 'projects'), 'dir')

    const rows = await scanSessions({
      sharedRoot,
      profiles: [{ name: 'work', dir: iso }, { name: 'default', dir: shared }],
    })
    expect(rows.map(r => r.scope).sort()).toEqual(['work'])
    expect(rows[0].project).toBe('/w')
  })
})
