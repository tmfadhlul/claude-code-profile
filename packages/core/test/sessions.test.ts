import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTranscript, scanSessions, sessionScanCacheStats, headCwd, decodeProjectDir, recentSessions, resumeCommand, sessionOwner, sessionTitle } from '../src/sessions.js'

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

describe('cwd recovery for files too large to scan', () => {
  // Regression: with a session pool past the scan budget, every file came back truncated with
  // cwd=null, so project fell back to decodeProjectDir — which turns a hyphen in a real path
  // segment into a separator. `/Users/lp-stf00543/...` decoded to `/Users/lp/stf00543/...`,
  // so handoff's cwd match never fired and it reported "no session found for this project".
  it('decodeProjectDir is lossy for hyphenated path segments — hence the head read', () => {
    expect(decodeProjectDir('-Users-lp-stf00543-Development-x')).toBe('/Users/lp/stf00543/Development/x')
  })

  it('recovers cwd from the first whole record in the head slice', () => {
    const head = [
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'user', cwd: '/Users/lp-stf00543/Development/personal/ccprofiles' }),
    ].join('\n')
    expect(headCwd(head, r => r.cwd)).toBe('/Users/lp-stf00543/Development/personal/ccprofiles')
  })

  it('skips a trailing record cut mid-line by the byte cap', () => {
    const cut = JSON.stringify({ cwd: '/real/path' }).slice(0, 12) // truncated JSON
    expect(headCwd(`${JSON.stringify({ cwd: '/first' })}\n${cut}`, r => r.cwd)).toBe('/first')
    // a lone partial line yields nothing rather than a parse crash
    expect(headCwd(cut, r => r.cwd)).toBeNull()
  })

  it('reads the codex payload shape and skips unparseable or empty values', () => {
    const head = [
      'not json at all',
      JSON.stringify({ type: 'session_meta', payload: { cwd: '' } }),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/codex/proj' } }),
    ].join('\n') + '\n'
    expect(headCwd(head, r => r?.payload?.cwd)).toBe('/codex/proj')
    expect(headCwd('', r => r.cwd)).toBeNull()
  })
})

describe('recent sessions', () => {
  const rec = (type: string, ts: string, cwd = '/p') => JSON.stringify({ type, cwd, timestamp: ts, message: { content: 'x' } }) + '\n'

  it('ranks by last chat, not by creation or file mtime', async () => {
    const sharedRoot = join(home, 'shared')
    const pdir = join(sharedRoot, 'projects', 'p')
    await mkdir(pdir, { recursive: true })
    // old: created first but chatted in last; its mtime is older than the other file's
    await writeFile(join(pdir, 'old.jsonl'), rec('user', '2026-01-01T00:00:00Z') + rec('assistant', '2026-03-01T00:00:00Z'))
    await writeFile(join(pdir, 'new.jsonl'), rec('user', '2026-02-01T00:00:00Z'))
    await utimes(join(pdir, 'old.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'))
    // a plugin's SDK worker chatting later must not crowd out real sessions
    await writeFile(join(pdir, 'bot.jsonl'), JSON.stringify({ type: 'user', entrypoint: 'sdk-ts', timestamp: '2026-09-01T00:00:00Z', message: { content: 'x' } }) + '\n')
    const rows = await scanSessions({ sharedRoot, profiles: [] })
    const top = recentSessions(rows, 1)
    expect(top.map(r => r.session.id)).toEqual(['old'])
    expect(top[0].session.lastActivity).toBe(Date.parse('2026-03-01T00:00:00Z'))
  })

  it('prefers a custom title over the AI one', () => {
    const t = (type: string, k: string, v: string) => JSON.stringify({ type, [k]: v }) + '\n'
    expect(sessionTitle(t('ai-title', 'aiTitle', 'auto') + t('custom-title', 'customTitle', 'mine') + t('ai-title', 'aiTitle', 'auto2'))).toBe('mine')
    expect(sessionTitle(t('ai-title', 'aiTitle', 'auto'))).toBe('auto')
    expect(sessionTitle('')).toBeNull()
  })

  it('caps at the limit across projects', () => {
    const s = (id: string, t: number) => ({ id, mtime: 0, lastActivity: t, messageCount: 1, firstPrompt: null, gitBranch: null, model: null, sizeBytes: 1 })
    const rows = [
      { agent: 'claude' as const, scope: 'a', project: '/a', sessions: [s('a1', 5), s('a2', 1)] },
      { agent: 'claude' as const, scope: 'b', project: '/b', sessions: [s('b1', 3)] },
    ]
    expect(recentSessions(rows, 2).map(r => r.session.id)).toEqual(['a1', 'b1'])
  })

  it('builds a resume command through the owning profile', () => {
    const r = { agent: 'claude' as const, scope: 'shared', project: "/it's here", session: { id: 'abc' } as any }
    const profiles = [{ name: 'x', sharedSessions: false, launcher: 'cx', dir: '/h/.claude-x' }, { name: 'y', sharedSessions: true, launcher: 'cy', dir: '/h/.claude-y' }]
    expect(resumeCommand(r, sessionOwner(r, profiles))).toBe(`cd '/it'\\''s here' && cy --resume abc`)
    expect(resumeCommand({ ...r, scope: 'x' }, { launcher: null, dir: '/h/.claude-x' })).toBe(`cd '/it'\\''s here' && CLAUDE_CONFIG_DIR='/h/.claude-x' claude --resume abc`)
  })

  it('keeps a Codex sub-agent under its own id and out of the recent list', async () => {
    const dir = join(home, 'shared', 'sessions', '2026', '10', '12')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'rollout-sub.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'child', cwd: '/c', thread_source: 'subagent', source: { subagent: {} } } }) + '\n' +
      JSON.stringify({ type: 'session_meta', payload: { id: 'parent', cwd: '/c' } }) + '\n' +
      JSON.stringify({ type: 'response_item', timestamp: '2026-10-12T00:00:00Z', payload: { type: 'message', role: 'user', content: 'hi' } }) + '\n')
    const rows = await scanSessions({ sharedRoot: join(home, 'shared'), profiles: [] })
    expect(rows[0].sessions[0]).toMatchObject({ id: 'child', automated: true })
    expect(recentSessions(rows)).toEqual([])
  })
})
