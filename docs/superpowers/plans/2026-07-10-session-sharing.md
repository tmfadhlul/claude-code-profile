# Session Sharing Across Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let opted-in profiles share one pool of Claude Code session data (`projects/`, `todos/`, `shell-snapshots/`) via apply-managed symlinks, fully driven through clp CLI and UI, with a read-only projects/sessions viewer.

**Architecture:** A per-profile `sharedSessions` manifest flag (parallel to the existing `skipPermissions`). `apply` gains two new actions — `share-session-dir` (backup → union-merge into pool → replace with symlink) and `unshare-session-dir` (snapshot pool back into a real dir). A core `scanSessions` module reads the pool and each isolated profile's `projects/` for the viewer, surfaced by a `sessions` CLI command and a `GET /api/sessions` route with a new UI page.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod (manifest schema), Commander (CLI), Node `http` (UI server), React + Vite + Tailwind + shadcn/ui (UI), Vitest (tests).

## Global Constraints

- Pool location: `<manifestRoot>/shared/{projects,todos,shell-snapshots}`. Never name it `.claude-*` (discovery would treat it as a profile).
- Shared entries are exactly `['projects', 'todos', 'shell-snapshots']`.
- `sharedSessions` is NOT launcher-gated (unlike `skipPermissions`) — it applies to any profile.
- Union-merge on migration: pool copy wins on a path clash; source retained in the backup. Session UUIDs are unique, so real clashes don't occur.
- `unshare` must never delete pool data.
- Union-merge/copy uses `fs.cp(..., { recursive: true, force: false, errorOnExist: false })`.
- All tests use a sandboxed temp home (`mkdtemp` in core tests; `CCPROFILES_TEST_HOME` for CLI/API tests). Never touch real `~/.claude*` or the keychain.
- `ProfileDecl` is `z.infer` of `ProfileSchema`, so once the schema field is added, EVERY profile object literal in `src/` and `test/` must set `sharedSessions` or `tsc` fails. Task 1 fixes all of them.

---

### Task 1: Manifest schema field + fixtures

Add `sharedSessions` to the profile schema and update every object literal that constructs a profile so the build stays green.

**Files:**
- Modify: `packages/core/src/manifest.ts:22-32` (ProfileSchema)
- Modify: `packages/core/src/adopt.ts:41` (buildManifest literal)
- Modify: `packages/cli/src/ui/api.ts:101-107` (POST /api/profiles default literal)
- Test: `packages/core/test/manifest.test.ts` (new case + fixture at line 12)
- Modify (fixtures): `packages/core/test/apply.test.ts:22-25`, `packages/core/test/adopt.test.ts:50`

**Interfaces:**
- Produces: `ProfileDecl.sharedSessions: boolean` (defaults `false`), consumed by Tasks 2, 4, 5.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/manifest.test.ts` (mirror the existing `skipPermissions` case near line 120):

```ts
it('sharedSessions parses and defaults to false', () => {
  const withFlag = parseManifest(`
version: 1
hub: null
profiles:
  - name: a
    dir: '{home}/.claude-a'
    launcher: cl-a
    auth: env
    sharedSessions: true
mcpServers: {}
`)
  expect(withFlag.profiles[0].sharedSessions).toBe(true)

  const noFlag = parseManifest(`
version: 1
hub: null
profiles:
  - name: b
    dir: '{home}/.claude-b'
    launcher: cl-b
    auth: env
mcpServers: {}
`)
  expect(noFlag.profiles[0].sharedSessions).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/manifest.test.ts -t sharedSessions`
Expected: FAIL — `sharedSessions` is `undefined` (schema doesn't define it yet).

- [ ] **Step 3: Add the schema field**

In `packages/core/src/manifest.ts`, inside `ProfileSchema` (after the `skipPermissions` line):

```ts
const ProfileSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  launcher: z.string().nullable(),
  auth: z.enum(['oauth', 'api-key', 'env']),
  env: z.record(z.string()).default({}),
  links: z.record(z.string()).default({}),
  mcp: z.array(z.string()).default([]),
  settingsEnv: z.record(z.string()).default({}),
  skipPermissions: z.boolean().default(false),
  sharedSessions: z.boolean().default(false),
})
```

- [ ] **Step 4: Fix the TypeScript literals the new required output field breaks**

`packages/core/src/adopt.ts` — in the `profiles.map` return object (after `skipPermissions: false,`):

```ts
      settingsEnv: lp.settingsEnv,
      skipPermissions: false,
      sharedSessions: false,
    }
```

`packages/cli/src/ui/api.ts` — POST `/api/profiles` push literal (after `skipPermissions: false,`):

```ts
      settingsEnv: {},
      skipPermissions: false,
      sharedSessions: false,
    })
```

`packages/core/test/manifest.test.ts:12` — the shared `sample` literal, append to that line's object:

```ts
    auth: 'oauth' as const, env: {}, links: { skills: 'hub', commands: 'hub' }, mcp: ['playwright'], settingsEnv: {}, skipPermissions: false, sharedSessions: false,
```

`packages/core/test/apply.test.ts:22-25` — both profiles in the `manifest()` helper get `sharedSessions: false` (append inside each object, next to `skipPermissions: false`).

`packages/core/test/adopt.test.ts:50` — append `sharedSessions: false` to the profile literal.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/core/test/manifest.test.ts -t sharedSessions && npm run build`
Expected: test PASS; `tsc -b` clean (no missing-property errors).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/adopt.ts packages/cli/src/ui/api.ts packages/core/test/manifest.test.ts packages/core/test/apply.test.ts packages/core/test/adopt.test.ts
git commit -m "feat(core): add sharedSessions flag to profile schema"
```

---

### Task 2: Apply actions — share / unshare session dirs

Add the two symlink-migration actions plus a recursive backup helper.

**Files:**
- Modify: `packages/core/src/fsutil.ts` (add `backupTree`)
- Modify: `packages/core/src/apply.ts` (ApplyAction union, planApply, executeApply, describe)
- Test: `packages/core/test/apply.test.ts`

**Interfaces:**
- Consumes: `ProfileDecl.sharedSessions` (Task 1).
- Produces:
  - `ApplyAction` gains `{ kind: 'share-session-dir'; from: string; to: string }` and `{ kind: 'unshare-session-dir'; from: string; to: string }`.
  - `planApply(m, live, p, resolvedSettingsEnv?, sharedRoot?)` — new optional 5th param `sharedRoot: string`, default `join(p.home, '.ccprofiles', 'shared')`. Consumed by Task 4 (`plan.ts` passes `join(ctx.manifestRoot, 'shared')`).
  - `backupTree(src, backupRoot, stamp): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests**

First extend the top-of-file import in `packages/core/test/apply.test.ts:2` to add `readdir` and `lstat` (imports MUST stay top-level — do not add import lines mid-file):

```ts
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, lstat } from 'node:fs/promises'
```

Then append a new `describe` to the same file:

```ts
describe('shared sessions', () => {
  function sharedManifest(on: boolean): Manifest {
    return {
      version: 1, hub: null,
      profiles: [
        { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, settingsEnv: {},
          links: {}, mcp: [], skipPermissions: false, sharedSessions: on },
      ],
      mcpServers: {},
    }
  }

  it('migrates an existing projects dir into the pool and symlinks it', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    // seed a real session under the profile
    await mkdir(join(home, '.claude', 'projects', 'proj'), { recursive: true })
    await writeFile(join(home, '.claude', 'projects', 'proj', 's1.jsonl'), '{"cwd":"/tmp/proj"}\n')

    const actions = planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.map(a => a.kind)).toContain('share-session-dir')
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })

    // projects is now a symlink to the pool
    expect((await lstat(join(home, '.claude', 'projects'))).isSymbolicLink()).toBe(true)
    // the session moved into the pool
    expect(existsSync(join(sharedRoot, 'projects', 'proj', 's1.jsonl'))).toBe(true)
    // a backup was taken
    expect((await readdir(join(home, '.ccprofiles', 'backups'))).length).toBeGreaterThan(0)
  })

  it('is idempotent once symlinked', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    let actions = planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot)
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    actions = planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.some(a => a.kind === 'share-session-dir')).toBe(false)
  })

  it('unshare restores a real dir seeded from the pool without deleting the pool', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    await executeApply(
      planApply(sharedManifest(true), await discoverProfiles(home), p, undefined, sharedRoot),
      { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    await mkdir(join(sharedRoot, 'projects', 'proj'), { recursive: true })
    await writeFile(join(sharedRoot, 'projects', 'proj', 's1.jsonl'), '{"cwd":"/tmp/proj"}\n')

    const actions = planApply(sharedManifest(false), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.map(a => a.kind)).toContain('unshare-session-dir')
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't2' })

    expect((await lstat(join(home, '.claude', 'projects'))).isSymbolicLink()).toBe(false)
    expect(existsSync(join(home, '.claude', 'projects', 'proj', 's1.jsonl'))).toBe(true) // snapshot copied back
    expect(existsSync(join(sharedRoot, 'projects', 'proj', 's1.jsonl'))).toBe(true)      // pool intact
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/apply.test.ts -t "shared sessions"`
Expected: FAIL — `planApply` doesn't accept `sharedRoot`, no `share-session-dir` action emitted.

- [ ] **Step 3: Add `backupTree` to `packages/core/src/fsutil.ts`**

Change the imports line and append the function:

```ts
import { copyFile, cp, mkdir, rename, writeFile } from 'node:fs/promises'
```

```ts
export async function backupTree(src: string, backupRoot: string, stamp: string): Promise<string | null> {
  if (!existsSync(src)) return null
  const dir = join(backupRoot, stamp)
  const dest = join(dir, sanitize(src))
  await mkdir(dir, { recursive: true })
  await cp(src, dest, { recursive: true })
  return dest
}
```

- [ ] **Step 4: Extend the ApplyAction union and imports in `packages/core/src/apply.ts`**

Imports (line 1) — add `cp`, `rm`:

```ts
import { cp, lstat, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises'
```

Import `backupTree` alongside the existing fsutil import (line 8):

```ts
import { atomicWrite, backupFiles, backupTree } from './fsutil.js'
```

Union (after the `set-settings-env` member):

```ts
  | { kind: 'set-settings-env'; settingsPath: string; env: Record<string, string> }
  | { kind: 'share-session-dir'; from: string; to: string }
  | { kind: 'unshare-session-dir'; from: string; to: string }
```

Add the shared-entry constant near the top (after `SECRET_PREFIX`):

```ts
const SHARED_ENTRIES = ['projects', 'todos', 'shell-snapshots'] as const
```

- [ ] **Step 5: Add the `sharedRoot` param + planning logic to `planApply`**

Change the signature (line 48):

```ts
export function planApply(m: Manifest, live: LiveProfile[], p: Platform, resolvedSettingsEnv?: Record<string, Record<string, string>>, sharedRoot: string = join(p.home, '.ccprofiles', 'shared')): ApplyAction[] {
```

Inside the `for (const pr of m.profiles)` loop, after the `pr.links` loop (right before the `settingsEnv` handling at line 74):

```ts
    for (const entry of SHARED_ENTRIES) {
      const from = join(dir, entry)
      const to = join(sharedRoot, entry)
      const linkedToPool = lp?.links[entry] === to
      if (pr.sharedSessions && !linkedToPool) actions.push({ kind: 'share-session-dir', from, to })
      else if (!pr.sharedSessions && linkedToPool) actions.push({ kind: 'unshare-session-dir', from, to })
    }
```

- [ ] **Step 6: Add the executors to `executeApply`**

Inside the action loop (after the `set-settings-env` branch, before the closing `}` of the `for`):

```ts
    } else if (a.kind === 'share-session-dir') {
      await mkdir(a.to, { recursive: true })
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try { st = await lstat(a.from) } catch { /* absent */ }
      if (st && !st.isSymbolicLink()) {
        await backupTree(a.from, opts.backupRoot, opts.stamp)
        await cp(a.from, a.to, { recursive: true, force: false, errorOnExist: false })
        await rm(a.from, { recursive: true, force: true })
      } else if (st && st.isSymbolicLink()) {
        await unlink(a.from)
      }
      await mkdir(dirname(a.from), { recursive: true })
      await symlink(a.to, a.from, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (a.kind === 'unshare-session-dir') {
      try { const st = await lstat(a.from); if (st.isSymbolicLink()) await unlink(a.from) } catch { /* absent */ }
      await mkdir(a.from, { recursive: true })
      if (existsSync(a.to)) await cp(a.to, a.from, { recursive: true, force: false, errorOnExist: false })
```

Note: `existsSync` is already imported at line 2; `dirname` at line 3.

- [ ] **Step 7: Add `describe()` cases**

In `describe()` (after `set-settings-env`):

```ts
    case 'share-session-dir': return `share ${a.from} -> ${a.to}`
    case 'unshare-session-dir': return `unshare ${a.from} (seed from ${a.to})`
```

- [ ] **Step 8: Run tests + build**

Run: `npx vitest run packages/core/test/apply.test.ts && npm run build`
Expected: all apply tests PASS (including the pre-existing kinds test — with `sharedSessions: false` no new actions are emitted), build clean.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/fsutil.ts packages/core/src/apply.ts packages/core/test/apply.test.ts
git commit -m "feat(core): share/unshare session-dir apply actions"
```

---

### Task 3: Session scanner module

A reusable reader that turns the pool and isolated profiles' `projects/` into a viewer-friendly structure.

**Files:**
- Create: `packages/core/src/sessions.ts`
- Modify: `packages/core/src/index.ts` (export the new module)
- Test: `packages/core/test/sessions.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionMeta { id: string; mtime: number; messageCount: number; firstPrompt: string | null; gitBranch: string | null; model: string | null; sizeBytes: number }`
  - `interface ProjectSessions { scope: string; project: string; sessions: SessionMeta[] }`
  - `scanSessions(opts: { sharedRoot: string; profiles: { name: string; dir: string }[] }): Promise<ProjectSessions[]>`
  - Consumed by Tasks 4 (CLI) and 5 (API).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/sessions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/sessions.test.ts`
Expected: FAIL — `../src/sessions.js` cannot be resolved.

- [ ] **Step 3: Create `packages/core/src/sessions.ts`**

```ts
import { readdir, readFile, stat, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionMeta {
  id: string
  mtime: number
  messageCount: number
  firstPrompt: string | null
  gitBranch: string | null
  model: string | null
  sizeBytes: number
}

export interface ProjectSessions {
  scope: string   // 'shared' or a profile name
  project: string // real cwd from the transcript, else best-effort decoded dir name
  sessions: SessionMeta[]
}

/** Best-effort decode of Claude Code's project dir name (cwd from a record is preferred). */
export function decodeProjectDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/')
}

async function parseSession(file: string): Promise<{ meta: SessionMeta; cwd: string | null } | null> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const st = await stat(file)
  const lines = raw.split('\n').filter(l => l.trim())
  let firstPrompt: string | null = null, gitBranch: string | null = null, model: string | null = null, cwd: string | null = null
  for (const line of lines) {
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd
    if (gitBranch === null && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch
    if (firstPrompt === null && rec.type === 'user') {
      const c = rec.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x?.type === 'text')?.text : null
      if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) firstPrompt = text.trim().slice(0, 200)
    }
    if (model === null && typeof rec.message?.model === 'string') model = rec.message.model
    if (firstPrompt && model && gitBranch && cwd) break
  }
  const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
  return { meta: { id, mtime: st.mtimeMs, messageCount: lines.length, firstPrompt, gitBranch, model, sizeBytes: st.size }, cwd }
}

async function scanProjectsDir(projectsDir: string, scope: string): Promise<ProjectSessions[]> {
  if (!existsSync(projectsDir)) return []
  const out: ProjectSessions[] = []
  for (const proj of await readdir(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const pdir = join(projectsDir, proj.name)
    const sessions: SessionMeta[] = []
    let cwd: string | null = null
    for (const f of await readdir(pdir)) {
      if (!f.endsWith('.jsonl')) continue
      const parsed = await parseSession(join(pdir, f))
      if (!parsed) continue
      sessions.push(parsed.meta)
      if (cwd === null) cwd = parsed.cwd
    }
    if (!sessions.length) continue
    sessions.sort((a, b) => b.mtime - a.mtime)
    out.push({ scope, project: cwd ?? decodeProjectDir(proj.name), sessions })
  }
  return out
}

export async function scanSessions(opts: {
  sharedRoot: string
  profiles: { name: string; dir: string }[]
}): Promise<ProjectSessions[]> {
  const out: ProjectSessions[] = []
  out.push(...await scanProjectsDir(join(opts.sharedRoot, 'projects'), 'shared'))
  for (const p of opts.profiles) {
    const projectsDir = join(p.dir, 'projects')
    try { if ((await lstat(projectsDir)).isSymbolicLink()) continue } catch { continue }
    out.push(...await scanProjectsDir(projectsDir, p.name))
  }
  return out
}
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Add (match the file's existing export style — named re-export):

```ts
export { scanSessions, decodeProjectDir, type SessionMeta, type ProjectSessions } from './sessions.js'
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run packages/core/test/sessions.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions.ts packages/core/src/index.ts packages/core/test/sessions.test.ts
git commit -m "feat(core): scanSessions reader for pool + isolated profiles"
```

---

### Task 4: CLI `sessions` command + pool-root threading

Expose share/unshare/list, and thread the real pool root through `plan.ts` so `CCPROFILES_HOME` is honored.

**Files:**
- Create: `packages/cli/src/commands/sessions.ts`
- Modify: `packages/cli/src/plan.ts` (pass `sharedRoot`)
- Modify: `packages/cli/src/context.ts` (register)
- Test: `packages/cli/test/sessions.test.ts`

**Interfaces:**
- Consumes: `scanSessions`, `executeApply` (core); `planActions` (plan.ts); `requireManifest` (context).
- Produces: `registerSessionCommands(program, ctx)`; CLI verbs `sessions share|unshare|list`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/sessions.test.ts` (follow the pattern in `packages/cli/test/cli.test.ts` for building context + program):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-sesscli-'))
  await mkdir(join(home, '.claude', 'projects', 'proj'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'projects', 'proj', 's1.jsonl'), '{"type":"user","cwd":"/tmp/proj","message":{"content":"hi there"}}\n')
})

function run(...args: string[]): Promise<void> {
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any)
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('sessions cli', () => {
  it('share symlinks the profile projects dir into the pool', async () => {
    await run('adopt', '--yes')
    await run('sessions', 'share', 'default')
    expect((await lstat(join(home, '.claude', 'projects'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, '.ccprofiles', 'shared', 'projects', 'proj', 's1.jsonl'))).toBe(true)
  })

  it('list prints the pooled session', async () => {
    await run('adopt', '--yes')
    await run('sessions', 'share', 'default')
    const lines: string[] = []
    const spy = console.log
    console.log = (...a: any[]) => { lines.push(a.join(' ')) }
    try { await run('sessions', 'list') } finally { console.log = spy }
    expect(lines.join('\n')).toContain('/tmp/proj')
    expect(lines.join('\n')).toContain('hi there')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/test/sessions.test.ts`
Expected: FAIL — `sessions` is not a known command.

- [ ] **Step 3: Thread `sharedRoot` through `packages/cli/src/plan.ts`**

Add the `join` import and pass the pool root:

```ts
import { discoverProfiles, planApply, resolveSettingsEnv, type ApplyAction, type Manifest, type SecretsStore } from 'ccprofiles-core'
import { join } from 'node:path'
import { secretsStore } from './commands/secrets.js'
import type { CliContext } from './context.js'

export async function planActions(ctx: CliContext, m: Manifest): Promise<ApplyAction[]> {
  let store: SecretsStore | null = null
  const resolved = await resolveSettingsEnv(m, async name => {
    store ??= await secretsStore(ctx)
    return store.get(name)
  })
  return planApply(m, await discoverProfiles(ctx.home), ctx.platform, resolved, join(ctx.manifestRoot, 'shared'))
}
```

- [ ] **Step 4: Create `packages/cli/src/commands/sessions.ts`**

```ts
import type { Command } from 'commander'
import { discoverProfiles, executeApply, saveManifest, scanSessions } from 'ccprofiles-core'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'

function profileName(dirName: string): string {
  return dirName === '.claude' ? 'default' : dirName.slice('.claude-'.length)
}
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerSessionCommands(program: Command, ctx: CliContext): void {
  const sessions = program.command('sessions').description('share Claude Code session history across profiles')

  async function setShared(name: string, on: boolean): Promise<void> {
    const m = await requireManifest(ctx)
    const pr = m.profiles.find(p => p.name === name)
    if (!pr) throw new Error(`unknown profile: ${name}`)
    pr.sharedSessions = on
    await saveManifest(ctx.manifestRoot, m)
    const actions = await planActions(ctx, m)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
    for (const line of r.performed) console.log(line)
  }

  sessions.command('share <profile>').description("pool this profile's sessions with other shared profiles")
    .action((name: string) => setShared(name, true))
  sessions.command('unshare <profile>').description('stop sharing; keep a local snapshot of the pool')
    .action((name: string) => setShared(name, false))

  sessions.command('list').description('list projects and their sessions').action(async () => {
    const live = await discoverProfiles(ctx.home)
    const rows = await scanSessions({
      sharedRoot: join(ctx.manifestRoot, 'shared'),
      profiles: live.map(lp => ({ name: profileName(lp.dirName), dir: lp.dir })),
    })
    if (!rows.length) { console.log('no sessions found'); return }
    for (const p of rows) {
      console.log(`\n[${p.scope}] ${p.project}`)
      for (const s of p.sessions)
        console.log(`  ${s.id.slice(0, 8)}  ${String(s.messageCount).padStart(4)} msg  ${s.firstPrompt ?? '(no prompt)'}`)
    }
  })
}
```

- [ ] **Step 5: Register in `packages/cli/src/context.ts`**

Add the import (next to the other `register*` imports):

```ts
import { registerSessionCommands } from './commands/sessions.js'
```

And call it inside `buildProgram` (after `registerProfileCommands(program, ctx)`):

```ts
  registerProfileCommands(program, ctx)
  registerSessionCommands(program, ctx)
```

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run packages/cli/test/sessions.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/sessions.ts packages/cli/src/plan.ts packages/cli/src/context.ts packages/cli/test/sessions.test.ts
git commit -m "feat(cli): sessions share/unshare/list command"
```

---

### Task 5: UI API — sessions route + profile flag

Surface the flag on profile rows/patch and add the sessions route.

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (import `scanSessions`; GET/PATCH `/api/profiles`; new `GET /api/sessions`)
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Consumes: `scanSessions` (core), `sharedSessions` (schema).
- Produces: `GET /api/sessions` → `ProjectSessions[]`; profile rows include `sharedSessions`; PATCH accepts `sharedSessions`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/ui-api-core.test.ts` (reuse its existing `callApi` helper and setup):

```ts
it('PATCH sharedSessions sets the flag and GET returns it', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedSessions: true })
  expect(res._status).toBe(200)
  const rows = (await callApi(ctx, 'GET', '/api/profiles'))._json
  expect(rows.find((r: any) => r.name === 'default').sharedSessions).toBe(true)
})

it('PATCH sharedSessions rejects a non-boolean', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedSessions: 'yes' })
  expect(res._status).toBe(400)
})

it('GET /api/sessions returns pooled projects', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedSessions: true })
  const rows = (await callApi(ctx, 'GET', '/api/sessions'))._json
  expect(Array.isArray(rows)).toBe(true)
})
```

Note: adapt `_status`/`_json` to whatever `callApi` in this file already returns (check the existing `skipPermissions` tests around line 117 for the exact shape and mirror it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts -t sharedSessions`
Expected: FAIL — PATCH ignores `sharedSessions`; GET row lacks it.

- [ ] **Step 3: Import `scanSessions` in `packages/cli/src/ui/api.ts`**

Add `scanSessions` to the `ccprofiles-core` import block (lines 1-6):

```ts
  atomicWrite, BEGIN_MARK, END_MARK, assertSafeManifest, preserveSecretRefs, scanSessions, type Manifest,
```

- [ ] **Step 4: Return `sharedSessions` on profile rows**

In `GET /api/profiles` row object (after `skipPermissions: decl?.skipPermissions ?? false,`):

```ts
        skipPermissions: decl?.skipPermissions ?? false,
        sharedSessions: decl?.sharedSessions ?? false,
      }
```

- [ ] **Step 5: Accept `sharedSessions` in PATCH**

Extend the `readJson` body type (line 119) to include `sharedSessions?: boolean`, then add handling after the `skipPermissions` block (after line 136, before the launcher-forces-off line):

```ts
    if (body.sharedSessions !== undefined) {
      if (typeof body.sharedSessions !== 'boolean') throw new HttpError(400, 'sharedSessions must be a boolean')
      pr.sharedSessions = body.sharedSessions
    }
```

- [ ] **Step 6: Add the `GET /api/sessions` route**

Place it next to the profiles routes (e.g. after the `DELETE /api/profiles/:name` handler, before `GET /api/status`):

```ts
  add('GET', /^\/api\/sessions$/, async (_m, _req, res) => {
    const live = await discoverProfiles(ctx.home)
    const rows = await scanSessions({
      sharedRoot: join(ctx.manifestRoot, 'shared'),
      profiles: live.map(lp => ({ name: profileName(lp.dirName), dir: lp.dir })),
    })
    sendJson(res, 200, rows)
  })
```

`discoverProfiles`, `join`, `profileName`, `sendJson` are already imported/defined in this file.

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/test/ui-api-core.test.ts
git commit -m "feat(api): sessions route + sharedSessions on profiles"
```

---

### Task 6: UI frontend — Sessions page + editor checkbox

Add the API client method, a read-only Sessions page + nav tab, and the profile-editor toggle.

**Files:**
- Modify: `packages/ui/src/lib/api.ts` (add `sessions`)
- Create: `packages/ui/src/pages/SessionsPage.tsx`
- Modify: `packages/ui/src/App.tsx` (nav tab)
- Modify: `packages/ui/src/components/ProfileEditor.tsx` (`ProfileRow` field + checkbox + patch)

**Interfaces:**
- Consumes: `GET /api/sessions` (Task 5), `sharedSessions` on profile rows/patch.

- [ ] **Step 1: Add the API client method**

In `packages/ui/src/lib/api.ts`, add inside the `api` object (after `doctor`):

```ts
  sessions: () => req('GET', '/api/sessions'),
```

- [ ] **Step 2: Create `packages/ui/src/pages/SessionsPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

type SessionMeta = {
  id: string; mtime: number; messageCount: number
  firstPrompt: string | null; gitBranch: string | null; model: string | null; sizeBytes: number
}
type ProjectSessions = { scope: string; project: string; sessions: SessionMeta[] }

export function SessionsPage() {
  const [data, setData] = useState<ProjectSessions[] | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  useEffect(() => { api.sessions().then(setData).catch((e: any) => toast.error(e.message)) }, [])
  if (!data) return null

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Sessions</h1>
      {data.length === 0 && <div className="text-sm text-muted-foreground">No sessions found.</div>}
      {data.map((p, i) => {
        const key = `${p.scope}:${p.project}:${i}`
        const open = openKey === key
        return (
          <div key={key} className="border rounded-lg">
            <button onClick={() => setOpenKey(open ? null : key)} className="w-full flex items-center justify-between gap-3 p-3 text-left">
              <span className="font-mono text-sm truncate">{p.project}</span>
              <span className="text-xs text-muted-foreground shrink-0">{p.scope} · {p.sessions.length} sessions</span>
            </button>
            {open && (
              <div className="border-t divide-y">
                {p.sessions.map(s => (
                  <div key={s.id} className="p-3 text-sm">
                    <div className="truncate">{s.firstPrompt ?? <span className="text-muted-foreground">(no prompt)</span>}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(s.mtime).toLocaleString()} · {s.messageCount} msg
                      {s.gitBranch ? ` · ${s.gitBranch}` : ''}{s.model ? ` · ${s.model}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Add the nav tab in `packages/ui/src/App.tsx`**

Import (add `History` to the lucide import and the page):

```tsx
import { SessionsPage } from '@/pages/SessionsPage'
import { LayoutDashboard, Users, Boxes, KeyRound, RefreshCw, Stethoscope, Terminal, History } from 'lucide-react'
```

Add to `TABS` (after the `profiles` entry):

```tsx
  ['profiles', 'Profiles', Users],
  ['sessions', 'Sessions', History],
```

Render it (after the profiles line):

```tsx
        {tab === 'profiles' && <ProfilesPage />}
        {tab === 'sessions' && <SessionsPage />}
```

- [ ] **Step 4: Add the toggle to `packages/ui/src/components/ProfileEditor.tsx`**

Add the field to `ProfileRow` (after `skipPermissions: boolean`):

```tsx
  skipPermissions: boolean
  sharedSessions: boolean
}
```

Add state (after the `skipPermissions` state, line 70):

```tsx
  const [sharedSessions, setSharedSessions] = useState(profile.sharedSessions)
```

Include it in the `patchProfile` call (in `save`, add to the object passed):

```tsx
      await api.patchProfile(profile.name, {
        env: fromEnvRows(env), settingsEnv: mergeProviderEnv(pform, fromEnvRows(padv)), links: linksObj, launcher: launcher.trim() || null,
        skipPermissions: launcher.trim() ? skipPermissions : false,
        sharedSessions,
      })
```

Add the checkbox UI (a new block after the skip-permissions `div`, ~line 117 — NOT launcher-gated):

```tsx
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sharedSessions} onChange={e => setSharedSessions(e.target.checked)} />
              Share session history (pool <span className="font-mono text-xs">projects / todos / shell-snapshots</span> with other shared profiles)
            </label>
            <p className="text-xs text-muted-foreground">First enable migrates this profile's existing sessions into the shared pool (a backup is taken).</p>
          </div>
```

- [ ] **Step 5: Build the UI + full suite**

Run: `npm run build && npx vitest run`
Expected: `vite build` succeeds (TypeScript clean), all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/api.ts packages/ui/src/pages/SessionsPage.tsx packages/ui/src/App.tsx packages/ui/src/components/ProfileEditor.tsx
git commit -m "feat(ui): Sessions page + sharedSessions toggle"
```

---

## Verification (end of plan)

- [ ] `npm run build` — `tsc -b` + `vite build` clean.
- [ ] `npx vitest run` — full suite green.
- [ ] Sandboxed manual check per `.claude/skills/verify/SKILL.md`: adopt → `sessions share default` → confirm `~/.claude/projects` is a symlink into `<manifestRoot>/shared/projects` and a backup exists → `sessions list` shows the project → `sessions unshare default` restores a real dir while the pool remains.

## Notes / known limitations (carried from the spec)

- Pooled sessions have no per-profile owner (Claude Code transcripts don't record the config dir); attribution shows only for isolated profiles.
- `scanSessions` reads each `.jsonl` fully to count messages; fine for v1, a candidate for streaming/caps later.
- `history` inside `.claude.json`, named sharing groups, UI delete/export, and clp plugin management are explicitly out of scope.
