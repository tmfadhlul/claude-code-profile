import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTranscript, scanSessions, sessionScanCacheStats } from '../src/sessions.js'

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

  it('caches unchanged files across scans and re-parses a file after its mtime changes', async () => {
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const pdir = join(sharedRoot, 'projects', 'encoded-proj')
    await mkdir(pdir, { recursive: true })
    const file = join(pdir, 'aaaaaaaa-0000.jsonl')
    await writeFile(file, '{"type":"user","cwd":"/tmp/proj","message":{"content":"hello world"}}\n')

    const first = await scanSessions({ sharedRoot, profiles: [] })
    expect(first[0].sessions[0].messageCount).toBe(1)
    const afterFirst = sessionScanCacheStats()

    // Second scan of the identical file: same results, and it must come from cache (no new miss).
    const second = await scanSessions({ sharedRoot, profiles: [] })
    expect(second).toEqual(first)
    const afterSecond = sessionScanCacheStats()
    expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits)
    expect(afterSecond.misses).toBe(afterFirst.misses)

    // Touch the file (new content + bumped mtime): must be re-parsed, not served stale from cache.
    await writeFile(file,
      '{"type":"user","cwd":"/tmp/proj","message":{"content":"hello world"}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n')
    const future = new Date(Date.now() + 60_000)
    await utimes(file, future, future)
    const third = await scanSessions({ sharedRoot, profiles: [] })
    expect(third[0].sessions[0].messageCount).toBe(2)
    const afterThird = sessionScanCacheStats()
    expect(afterThird.misses).toBeGreaterThan(afterSecond.misses)
  })
})

describe('readSessionTranscript', () => {
  it('reads visible Claude conversation and tool activity without system noise', async () => {
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const dir = join(sharedRoot, 'projects', 'proj')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'chat-1.jsonl'),
      '{"type":"user","cwd":"/tmp/project","timestamp":"2026-07-10T01:00:00Z","message":{"content":"build this"}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I will inspect it."},{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}\n' +
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"file contents"}]}}\n' +
      '{"type":"user","message":{"content":"<system-reminder>internal</system-reminder>"}}\n')

    const transcript = await readSessionTranscript({ sharedRoot, profiles: [], agent: 'claude', scope: 'shared', id: 'chat-1' })
    expect(transcript).toMatchObject({ id: 'chat-1', agent: 'claude', scope: 'shared', project: '/tmp/project' })
    expect(transcript?.messages.map(m => [m.role, m.label, m.text])).toEqual([
      ['user', null, 'build this'],
      ['assistant', null, 'I will inspect it.'],
      ['tool', 'Read', '{\n  "file_path": "a.ts"\n}'],
      ['tool', 'Tool result', 'file contents'],
    ])
  })

  it('reads Codex response messages, tool calls, and ignores duplicate event messages', async () => {
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const dir = join(sharedRoot, 'sessions', '2026', '07', '10')
    const id = '33333333-3333-4333-8333-333333333333'
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `rollout-${id}.jsonl`),
      `{"type":"session_meta","payload":{"id":"${id}","cwd":"/tmp/codex"}}\n` +
      '{"type":"event_msg","payload":{"type":"user_message","message":"duplicate"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix it"}]}}\n' +
      '{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"cmd\\":\\"npm test\\"}"}}\n' +
      '{"type":"response_item","payload":{"type":"function_call_output","output":"all passed"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}\n')

    const transcript = await readSessionTranscript({ sharedRoot, profiles: [], agent: 'codex', scope: 'shared', id })
    expect(transcript).toMatchObject({ id, agent: 'codex', project: '/tmp/codex' })
    expect(transcript?.messages.map(m => [m.role, m.label, m.text])).toEqual([
      ['user', null, 'fix it'],
      ['tool', 'shell', '{"cmd":"npm test"}'],
      ['tool', 'Tool result', 'all passed'],
      ['assistant', null, 'Done.'],
    ])
  })

  it('rejects traversal-shaped session ids', async () => {
    expect(await readSessionTranscript({
      sharedRoot: join(home, '.ccprofiles', 'shared'), profiles: [], agent: 'claude', scope: 'shared', id: '../secret',
    })).toBeNull()
  })
})
