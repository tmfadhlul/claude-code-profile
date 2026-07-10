/**
 * Manifest links use agent-neutral names. Translate only at filesystem edge so
 * one `commands: hub` declaration works for Claude Code and Codex profiles.
 */
export function physicalLinkEntry(agent: 'claude' | 'codex', entry: string): string {
  return agent === 'codex' && entry === 'commands' ? 'prompts' : entry
}

/** Convert discovered filesystem entry back to agent-neutral manifest name. */
export function logicalLinkEntry(agent: 'claude' | 'codex', entry: string): string {
  return agent === 'codex' && entry === 'prompts' ? 'commands' : entry
}
