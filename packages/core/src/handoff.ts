import type { ProjectSessions, SessionTranscript } from './sessions.js'
import type { OsKind } from './platform.js'

/**
 * Compare two absolute paths the way the OS would. Windows is case-insensitive and mixes
 * separators freely (`C:\p` / `c:/p` are one path), so a strict === there silently fails to
 * match a session against its own project. POSIX is case-sensitive — normalizing it would
 * merge genuinely distinct paths, so it stays exact.
 */
export function samePath(a: string, b: string, os: OsKind): boolean {
  if (os !== 'win32') return a === b
  const norm = (p: string) => p.replace(/[\\/]+/g, '\\').replace(/(.)\\+$/, '$1').toLowerCase()
  return norm(a) === norm(b)
}

export function findLastSessionForCwd(
  scanned: ProjectSessions[], cwd: string, scope: string, agent: 'claude' | 'codex',
  os: OsKind = 'linux',
): { scope: string; id: string } | null {
  let newest: { id: string; mtime: number } | null = null
  for (const p of scanned) {
    if (!samePath(p.project, cwd, os) || p.scope !== scope || p.agent !== agent) continue
    for (const s of p.sessions) if (!newest || s.mtime > newest.mtime) newest = { id: s.id, mtime: s.mtime }
  }
  return newest ? { scope, id: newest.id } : null
}

export function renderHandoffMarkdown(t: SessionTranscript): string {
  const lines: string[] = [
    '# Session handoff', '',
    `- **From:** ${t.agent}`,
    `- **Project:** ${t.project}`,
    `- **Session:** ${t.id}`,
    '', '---', '',
  ]
  for (const m of t.messages) {
    const heading = m.role === 'tool'
      ? `## Tool${m.label ? ` — ${m.label}` : ''}`
      : `## ${m.role === 'user' ? 'User' : 'Assistant'}`
    lines.push(heading, '', m.text, '')
  }
  return lines.join('\n')
}

export function buildHandoffLaunch(opts: {
  targetAgent: 'claude' | 'codex'
  targetDir: string
  targetEnv: Record<string, string>
  skipPermissions: boolean
  transcriptPath: string
  srcName: string
  srcAgent: 'claude' | 'codex'
  cwd: string
}): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  const homeVar = opts.targetAgent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const command = opts.targetAgent === 'codex' ? 'codex' : 'claude'
  const skipFlag = opts.skipPermissions
    ? (opts.targetAgent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions')
    : null
  const seedPrompt = `Continuing a session handed off from '${opts.srcName}' (${opts.srcAgent}). `
    + `The full prior transcript is at ${opts.transcriptPath}. Read it, then pick up where it left off.`
  const args = skipFlag ? [skipFlag, seedPrompt] : [seedPrompt]
  return { command, args, env: { [homeVar]: opts.targetDir, ...opts.targetEnv }, cwd: opts.cwd }
}
