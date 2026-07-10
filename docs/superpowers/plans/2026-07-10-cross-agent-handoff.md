# Cross-agent Session Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cl-oauth handoff codex-work` — open the target profile's agent seeded with the current project's most recent source-profile session, rendered to a transcript file.

**Architecture:** Launchers intercept `handoff <target>` and call `ccprofiles handoff --from <profile> --to <target>`. The command finds the newest source session for the current cwd (via the existing `scanSessions`), reads its normalized transcript (`readSessionTranscript`), renders it to markdown under `~/.ccprofiles/handoffs/`, then spawns the target agent (correct home var + resolved env + skip flag) with a seed prompt pointing at the file. Pure core helpers keep the logic testable; a `--print` dry-run avoids spawning in tests.

**Tech Stack:** TypeScript (ESM, NodeNext), Commander (CLI), Node `child_process.spawnSync`, Vitest.

## Global Constraints

- Handoff files live at `<manifestRoot>/handoffs/<stamp>-<srcId>.md`; the CLI supplies a filesystem-safe UTC stamp (`new Date().toISOString().replace(/[:.]/g, '-')`), keeping core pure.
- Target is an **explicit profile name** validated against the manifest. Errors: unknown `--from`/`--to`, `src === target`, no session in cwd.
- Home var: `CODEX_HOME` for a codex target, `CLAUDE_CONFIG_DIR` for a claude target. Skip flag: `--dangerously-bypass-approvals-and-sandbox` (codex) / `--dangerously-skip-permissions` (claude), only when the target's `skipPermissions` is set.
- Seed prompt (exact): `Continuing a session handed off from '<srcName>' (<srcAgent>). The full prior transcript is at <path>. Read it, then pick up where it left off.`
- The launcher `handoff` guard is the **first** line inside the function, before env exports. `--from` is the owning profile's `name`. Added to both claude and codex launchers.
- Profile names are injection-safe (manifest validation restricts them to letters/digits/`-`/`_`), so interpolating `pr.name` into the rc block is safe.
- All tests use sandboxed temp homes; never touch real `~/.claude*`/`~/.codex*`.

---

### Task 1: Core handoff helpers

Three pure functions plus exports. No filesystem, no spawning — all fs/spawn lives in the CLI (Task 3).

**Files:**
- Create: `packages/core/src/handoff.ts`
- Modify: `packages/core/src/index.ts` (export the new symbols)
- Test: `packages/core/test/handoff.test.ts`

**Interfaces:**
- Consumes (from `./sessions.js`): `ProjectSessions { agent: 'claude'|'codex'; scope: string; project: string; sessions: SessionMeta[] }`, `SessionMeta { id: string; mtime: number; ... }`, `SessionTranscript { id; agent; scope; project; messages: TranscriptEntry[] }`, `TranscriptEntry { id; role: 'user'|'assistant'|'tool'; text: string; label: string|null; timestamp: string|null }`.
- Produces:
  - `findLastSessionForCwd(scanned: ProjectSessions[], cwd: string, scope: string, agent: 'claude'|'codex'): { scope: string; id: string } | null`
  - `renderHandoffMarkdown(t: SessionTranscript): string`
  - `buildHandoffLaunch(opts: { targetAgent: 'claude'|'codex'; targetDir: string; targetEnv: Record<string,string>; skipPermissions: boolean; transcriptPath: string; srcName: string; srcAgent: 'claude'|'codex'; cwd: string }): { command: string; args: string[]; env: Record<string,string>; cwd: string }`
  - All consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/handoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { findLastSessionForCwd, renderHandoffMarkdown, buildHandoffLaunch } from '../src/handoff.js'
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/handoff.test.ts`
Expected: FAIL — `../src/handoff.js` cannot be resolved.

- [ ] **Step 3: Create `packages/core/src/handoff.ts`**

```ts
import type { ProjectSessions, SessionTranscript } from './sessions.js'

export function findLastSessionForCwd(
  scanned: ProjectSessions[], cwd: string, scope: string, agent: 'claude' | 'codex',
): { scope: string; id: string } | null {
  let newest: { id: string; mtime: number } | null = null
  for (const p of scanned) {
    if (p.project !== cwd || p.scope !== scope || p.agent !== agent) continue
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
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Add (match the file's existing `export * from './x.js'` barrel style):

```ts
export * from './handoff.js'
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run packages/core/test/handoff.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/handoff.ts packages/core/src/index.ts packages/core/test/handoff.test.ts
git commit -m "feat(core): handoff helpers — find last session, render markdown, build launch"
```

---

### Task 2: Launcher `handoff` intercept

Add the intercept line to both launcher renderers.

**Files:**
- Modify: `packages/core/src/rcblock.ts` (`renderPosix`, `renderPwsh`)
- Test: `packages/core/test/rcblock.test.ts` (add cases)

**Interfaces:**
- No new exports. Changes the string produced by `renderRcBlock`.

- [ ] **Step 1: Write the failing test**

First ensure these imports exist at the **top** of `packages/core/test/rcblock.test.ts` — add any that are missing, do NOT duplicate existing ones, and do NOT put `import` lines inside the `describe` block (imports must stay top-level):

```ts
import { describe, it, expect } from 'vitest'
import { renderRcBlock } from '../src/rcblock.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'
```

Then append this `describe` block (helper + tests, no import lines):

```ts
function manifestWith(agent: 'claude' | 'codex'): Manifest {
  return {
    version: 1, hub: null, mcpServers: {},
    profiles: [{
      agent, name: agent === 'codex' ? 'codex-work' : 'oauth',
      dir: agent === 'codex' ? '{home}/.codex-work' : '{home}/.claude-oauth',
      launcher: agent === 'codex' ? 'cx-work' : 'cl-oauth',
      auth: 'oauth', env: {}, links: {}, mcp: [], settingsEnv: {},
      skipPermissions: false, sharedSessions: false,
    }],
  }
}

describe('handoff intercept in launchers', () => {
  it('posix launcher intercepts handoff before env, bound to the profile name', () => {
    const p = detectPlatform({ osKind: 'darwin', home: '/home/u', shell: '/bin/zsh' })
    const block = renderRcBlock(manifestWith('claude'), p)
    expect(block).toContain('cl-oauth() {')
    expect(block).toContain('if [ "$1" = handoff ]; then shift; command ccprofiles handoff --from oauth --to "$1"; return; fi')
    // guard precedes the launch line
    expect(block.indexOf('handoff --from oauth')).toBeLessThan(block.indexOf('CLAUDE_CONFIG_DIR='))
  })
  it('codex launcher gets a handoff intercept too', () => {
    const p = detectPlatform({ osKind: 'darwin', home: '/home/u', shell: '/bin/zsh' })
    const block = renderRcBlock(manifestWith('codex'), p)
    expect(block).toContain('command ccprofiles handoff --from codex-work --to "$1"')
  })
  it('powershell launcher intercepts handoff', () => {
    const p = detectPlatform({ osKind: 'win32', home: 'C:/Users/u', shell: 'pwsh' })
    const block = renderRcBlock(manifestWith('claude'), p)
    expect(block).toContain("if ($args[0] -eq 'handoff') { ccprofiles handoff --from oauth --to $args[1]; return }")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/rcblock.test.ts -t handoff`
Expected: FAIL — the intercept line isn't rendered yet.

- [ ] **Step 3: Add the intercept to `renderPosix`**

In `packages/core/src/rcblock.ts`, `renderPosix`, right after `const lines = [`${pr.launcher}() {`]`:

```ts
function renderPosix(pr: ProfileDecl, p: Platform): string {
  const lines = [`${pr.launcher}() {`]
  lines.push(`  if [ "$1" = handoff ]; then shift; command ccprofiles handoff --from ${pr.name} --to "$1"; return; fi`)
  for (const [k, v] of Object.entries(pr.env)) {
```

- [ ] **Step 4: Add the intercept to `renderPwsh`**

In `renderPwsh`, right after `const lines = [`function ${pr.launcher} {`]`:

```ts
function renderPwsh(pr: ProfileDecl, p: Platform): string {
  const lines = [`function ${pr.launcher} {`]
  lines.push(`  if ($args[0] -eq 'handoff') { ccprofiles handoff --from ${pr.name} --to $args[1]; return }`)
  for (const [k, v] of Object.entries(pr.env)) {
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run packages/core/test/rcblock.test.ts && npm run build`
Expected: PASS (new + existing rcblock tests); build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/rcblock.ts packages/core/test/rcblock.test.ts
git commit -m "feat(core): launcher handoff intercept (posix + pwsh)"
```

---

### Task 3: CLI `handoff` command

Wire the pieces: resolve profiles, find the session, render + write the file, resolve target env, launch (or `--print`).

**Files:**
- Create: `packages/cli/src/commands/handoff.ts`
- Modify: `packages/cli/src/context.ts` (register)
- Test: `packages/cli/test/handoff.test.ts`

**Interfaces:**
- Consumes: `scanSessions`, `readSessionTranscript`, `renderHandoffMarkdown`, `findLastSessionForCwd`, `buildHandoffLaunch`, `renderPath` (all from `ccprofiles-core`); `requireManifest` (context); `secretsStore` (secrets command).
- Produces: `registerHandoffCommands(program, ctx)`; CLI verb `handoff --from <p> --to <p> [--print]`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/handoff.test.ts` (follow `packages/cli/test/sessions.test.ts` for context/program setup):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-handoff-'))
  // source: a claude profile 'a'
  await mkdir(join(home, '.claude-a'), { recursive: true })
  await writeFile(join(home, '.claude-a', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  // target: a codex profile -> name 'codex-b'
  await mkdir(join(home, '.codex-b'), { recursive: true })
  await writeFile(join(home, '.codex-b', 'config.toml'), 'model = "gpt-5-codex"\n')
  await writeFile(join(home, '.codex-b', 'auth.json'), '{"tokens":{}}')
})

function run(...args: string[]): Promise<void> {
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('handoff cli', () => {
  it('--print writes a transcript file and prints a launch targeting the other agent', async () => {
    await run('adopt', '--yes')
    // seed a claude session for profile 'a' whose recorded cwd == this test's cwd
    const pdir = join(home, '.claude-a', 'projects', 'proj')
    await mkdir(pdir, { recursive: true })
    await writeFile(join(pdir, 'sess-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: process.cwd(), message: { content: 'prior work here' } }) + '\n')

    const lines: string[] = []
    const spy = console.log
    console.log = (...a: any[]) => { lines.push(a.join(' ')) }
    try { await run('handoff', '--from', 'a', '--to', 'codex-b', '--print') } finally { console.log = spy }

    const out = lines.join('\n')
    const fileLine = lines.find(l => l.startsWith('handoff file: '))!
    const file = fileLine.replace('handoff file: ', '').trim()
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('prior work here')
    expect(out).toContain('command: codex')
    expect(out).toContain(`CODEX_HOME=${join(home, '.codex-b')}`)
    expect(out).toContain('Read it, then pick up where it left off')
  })

  it('errors when there is no session for this project', async () => {
    await run('adopt', '--yes')
    await expect(run('handoff', '--from', 'a', '--to', 'codex-b', '--print')).rejects.toThrow(/no a session/)
  })

  it('rejects handoff to the same profile', async () => {
    await run('adopt', '--yes')
    await expect(run('handoff', '--from', 'a', '--to', 'a', '--print')).rejects.toThrow(/same profile/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/test/handoff.test.ts`
Expected: FAIL — `handoff` is not a known command.

- [ ] **Step 3: Create `packages/cli/src/commands/handoff.ts`**

```ts
import type { Command } from 'commander'
import {
  scanSessions, readSessionTranscript, renderHandoffMarkdown,
  findLastSessionForCwd, buildHandoffLaunch, renderPath,
} from 'ccprofiles-core'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { secretsStore } from './secrets.js'

const SECRET_PREFIX = 'secret://'
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

async function resolveEnv(ctx: CliContext, env: Record<string, string>): Promise<Record<string, string>> {
  let store: Awaited<ReturnType<typeof secretsStore>> | null = null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v.startsWith(SECRET_PREFIX)) {
      store ??= await secretsStore(ctx)
      const val = await store.get(v.slice(SECRET_PREFIX.length))
      if (val === null) throw new Error(`secret not found: ${v.slice(SECRET_PREFIX.length)} (for ${k})`)
      out[k] = val
    } else out[k] = v
  }
  return out
}

export function registerHandoffCommands(program: Command, ctx: CliContext): void {
  program.command('handoff')
    .description("hand off the current project's latest session to another profile's agent")
    .requiredOption('--from <profile>', 'source profile (owns the session)')
    .requiredOption('--to <profile>', 'target profile (agent to open)')
    .option('--print', 'write the handoff file and print the launch command instead of opening the agent')
    .action(async (opts: { from: string; to: string; print?: boolean }) => {
      const m = await requireManifest(ctx)
      const src = m.profiles.find(p => p.name === opts.from)
      if (!src) throw new Error(`unknown profile: ${opts.from}`)
      const target = m.profiles.find(p => p.name === opts.to)
      if (!target) throw new Error(`unknown profile: ${opts.to}`)
      if (src.name === target.name) throw new Error('source and target are the same profile')

      const srcAgent = src.agent ?? 'claude'
      const targetAgent = target.agent ?? 'claude'
      const sharedRoot = join(ctx.manifestRoot, 'shared')
      const profiles = m.profiles.map(p => ({ name: p.name, dir: renderPath(p.dir, ctx.platform), agent: p.agent ?? 'claude' }))
      const srcDir = renderPath(src.dir, ctx.platform)

      // effective scope: 'shared' if the source's session dir is pooled, else the profile name
      const srcSessionDir = join(srcDir, srcAgent === 'codex' ? 'sessions' : 'projects')
      let scope = src.name
      try { if ((await lstat(srcSessionDir)).isSymbolicLink()) scope = 'shared' } catch { /* not pooled */ }

      const cwd = process.cwd()
      const scanned = await scanSessions({ sharedRoot, profiles })
      const found = findLastSessionForCwd(scanned, cwd, scope, srcAgent)
      if (!found) throw new Error(`no ${opts.from} session found for this project (${cwd})`)

      const transcript = await readSessionTranscript({ sharedRoot, profiles, agent: srcAgent, scope: found.scope, id: found.id })
      if (!transcript) throw new Error(`could not read session ${found.id}`)

      const dir = join(ctx.manifestRoot, 'handoffs')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${stamp()}-${found.id}.md`)
      await writeFile(file, renderHandoffMarkdown(transcript), 'utf8')

      const targetEnv = await resolveEnv(ctx, target.env)
      const launch = buildHandoffLaunch({
        targetAgent, targetDir: renderPath(target.dir, ctx.platform), targetEnv,
        skipPermissions: target.skipPermissions, transcriptPath: file,
        srcName: src.name, srcAgent, cwd,
      })

      if (opts.print) {
        console.log(`handoff file: ${file}`)
        console.log(`command: ${launch.command} ${launch.args.map(a => JSON.stringify(a)).join(' ')}`)
        console.log(`env: ${Object.entries(launch.env).map(([k, v]) => `${k}=${v}`).join(' ')}`)
        console.log(`cwd: ${launch.cwd}`)
        return
      }
      const res = spawnSync(launch.command, launch.args, { stdio: 'inherit', cwd: launch.cwd, env: { ...process.env, ...launch.env } })
      if (res.error) throw res.error
      if (typeof res.status === 'number' && res.status !== 0) process.exitCode = res.status
    })
}
```

- [ ] **Step 4: Register in `packages/cli/src/context.ts`**

Add the import (with the other `register*` imports):

```ts
import { registerHandoffCommands } from './commands/handoff.js'
```

Call it inside `buildProgram` (after `registerSessionCommands(program, ctx)`):

```ts
  registerSessionCommands(program, ctx)
  registerHandoffCommands(program, ctx)
```

- [ ] **Step 5: Run tests + build + full suite**

Run: `npx vitest run packages/cli/test/handoff.test.ts && npm run build && npx vitest run`
Expected: handoff tests PASS; build clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/handoff.ts packages/cli/src/context.ts packages/cli/test/handoff.test.ts
git commit -m "feat(cli): handoff command — open target agent seeded with prior session"
```

---

## Verification (end of plan)

- [ ] `npm run build` — `tsc -b` + `vite build` clean.
- [ ] `npx vitest run` — full suite green.
- [ ] Sandboxed manual check per `.claude/skills/verify/SKILL.md`: adopt two profiles (a claude + a codex), seed a claude session whose `cwd` matches a sandbox dir, run `node packages/cli/dist/index.js handoff --from <claude> --to <codex> --print` → a handoff `.md` is written with the transcript and the printed command targets the codex agent with `CODEX_HOME` + the seed prompt. Then confirm `clp apply` writes the `handoff` intercept into a launcher in the sandbox rc file.

## Notes / limitations (from the spec)

- No true native cross-resume; this briefs the target in a fresh session.
- No LLM summarization; the full normalized transcript is handed over.
- Target is an explicit profile name; no agent-keyword inference.
- Existing launchers need one `clp apply` to gain the `handoff` intercept.
