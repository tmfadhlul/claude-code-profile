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

  it('reads Codex rollout sessions recursively and groups them by cwd', async () => {
    const profile = join(home, '.codex-work')
    const dir = join(profile, 'sessions', '2026', '07', '10')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'rollout-2026-07-10T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'),
      '{"type":"session_meta","payload":{"id":"11111111-1111-4111-8111-111111111111","cwd":"/tmp/codex-project","git":{"branch":"feature/codex"}}}\n' +
      '{"type":"turn_context","payload":{"cwd":"/tmp/codex-project","model":"gpt-5.4"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"resume me elsewhere"}]}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}\n')

    const rows = await scanSessions({
      sharedRoot: join(home, '.ccprofiles', 'shared'),
      profiles: [{ name: 'codex-work', dir: profile, agent: 'codex' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'codex', scope: 'codex-work', project: '/tmp/codex-project' })
    expect(rows[0].sessions[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111', firstPrompt: 'resume me elsewhere',
      gitBranch: 'feature/codex', model: 'gpt-5.4', messageCount: 2,
    })
  })

  it('reads shared Codex sessions once and skips symlinked profile sessions', async () => {
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const pool = join(sharedRoot, 'sessions')
    const dated = join(pool, '2026', '07', '10')
    await mkdir(dated, { recursive: true })
    await writeFile(join(dated, 'rollout-22222222-2222-4222-8222-222222222222.jsonl'),
      '{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222","cwd":"/tmp/shared-codex"}}\n')
    const profile = join(home, '.codex-work')
    await mkdir(profile, { recursive: true })
    await symlink(pool, join(profile, 'sessions'), 'dir')

    const rows = await scanSessions({
      sharedRoot,
      profiles: [{ name: 'codex-work', dir: profile, agent: 'codex' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'codex', scope: 'shared', project: '/tmp/shared-codex' })
  })
})
