import { describe, it, expect } from 'vitest'
import { findLastSessionForCwd, renderHandoffMarkdown, buildHandoffLaunch, samePath } from '../src/handoff.js'
import type { ProjectSessions, SessionTranscript } from '../src/sessions.js'

function meta(id: string, mtime: number) {
  return { id, mtime, messageCount: 1, firstPrompt: null, gitBranch: null, model: null, sizeBytes: 0 }
}

describe('findLastSessionForCwd', () => {
  const scanned: ProjectSessions[] = [
    { agent: 'claude', scope: 'a', project: '/proj', sessions: [meta('new', 200), meta('old', 100)] },
    { agent: 'claude', scope: 'a', project: '/other', sessions: [meta('x', 999)] },
    { agent: 'codex', scope: 'a', project: '/proj', sessions: [meta('cdx', 300)] },
  ]
  it('returns the newest session matching cwd + scope + agent', () => {
    expect(findLastSessionForCwd(scanned, '/proj', 'a', 'claude')).toEqual({ scope: 'a', id: 'new' })
  })
  it('excludes other agents in the same cwd/scope', () => {
    // the codex entry (mtime 300) is newer but wrong agent
    expect(findLastSessionForCwd(scanned, '/proj', 'a', 'claude')?.id).toBe('new')
    expect(findLastSessionForCwd(scanned, '/proj', 'a', 'codex')).toEqual({ scope: 'a', id: 'cdx' })
  })
  it('returns null when no session matches the cwd', () => {
    expect(findLastSessionForCwd(scanned, '/nope', 'a', 'claude')).toBeNull()
  })
})

describe('renderHandoffMarkdown', () => {
  it('renders header + role sections', () => {
    const t: SessionTranscript = {
      id: 'sid', agent: 'claude', scope: 'a', project: '/proj',
      messages: [
        { id: '1', role: 'user', text: 'do the thing', label: null, timestamp: null },
        { id: '2', role: 'assistant', text: 'done', label: null, timestamp: null },
        { id: '3', role: 'tool', text: '{"ok":true}', label: 'Bash', timestamp: null },
      ],
    }
    const md = renderHandoffMarkdown(t)
    expect(md).toContain('# Session handoff')
    expect(md).toContain('**Project:** /proj')
    expect(md).toContain('## User')
    expect(md).toContain('do the thing')
    expect(md).toContain('## Assistant')
    expect(md).toContain('## Tool — Bash')
  })
})

describe('buildHandoffLaunch', () => {
  it('builds a claude target launch', () => {
    const l = buildHandoffLaunch({
      targetAgent: 'claude', targetDir: '/home/.claude-work', targetEnv: { FOO: 'bar' },
      skipPermissions: false, transcriptPath: '/h/x.md', srcName: 'codex-work', srcAgent: 'codex', cwd: '/proj',
    })
    expect(l.command).toBe('claude')
    expect(l.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/.claude-work', FOO: 'bar' })
    expect(l.args).toEqual([expect.stringContaining("handed off from 'codex-work' (codex)")])
    expect(l.args[0]).toContain('/h/x.md')
    expect(l.cwd).toBe('/proj')
  })
  it('builds a codex target with skip flag first', () => {
    const l = buildHandoffLaunch({
      targetAgent: 'codex', targetDir: '/home/.codex-work', targetEnv: {},
      skipPermissions: true, transcriptPath: '/h/x.md', srcName: 'oauth', srcAgent: 'claude', cwd: '/proj',
    })
    expect(l.command).toBe('codex')
    expect(l.env).toEqual({ CODEX_HOME: '/home/.codex-work' })
    expect(l.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox')
    expect(l.args[1]).toContain('/h/x.md')
  })
})

describe('samePath / windows project matching', () => {
  // decodeProjectDir is POSIX-only ('C--Users-foo' decodes to 'C//Users/foo'), so on Windows
  // the cwd recorded inside the transcript is the ONLY usable source — and it has to compare
  // the way Windows does, or handoff misses its own project on a case or separator difference.
  it('treats case and separator differences as the same path on win32', () => {
    expect(samePath('C:\\Users\\foo\\dev', 'c:/users/foo/dev', 'win32')).toBe(true)
    expect(samePath('C:\\Users\\foo\\dev\\', 'C:\\Users\\foo\\dev', 'win32')).toBe(true)
    expect(samePath('C:\\Users\\foo', 'C:\\Users\\bar', 'win32')).toBe(false)
  })

  it('stays exact on posix, where case and separators are meaningful', () => {
    expect(samePath('/Users/Foo', '/users/foo', 'darwin')).toBe(false)
    expect(samePath('/Users/foo', '/Users/foo', 'linux')).toBe(true)
  })

  it('does not collapse a drive root to the empty string', () => {
    expect(samePath('C:\\', 'c:/', 'win32')).toBe(true)
    expect(samePath('C:\\', 'd:/', 'win32')).toBe(false)
  })

  it('finds a windows session whose transcript cwd differs only in case', () => {
    const scanned = [{ agent: 'claude' as const, scope: 'shared', project: 'C:\\Users\\foo\\my-app',
      sessions: [{ id: 's1', mtime: 5, messageCount: 1, firstPrompt: null, gitBranch: null, model: null, sizeBytes: 1 }] }]
    expect(findLastSessionForCwd(scanned, 'c:\\users\\foo\\my-app', 'shared', 'claude', 'win32')?.id).toBe('s1')
    expect(findLastSessionForCwd(scanned, 'c:\\users\\foo\\my-app', 'shared', 'claude', 'linux')).toBeNull()
  })
})
