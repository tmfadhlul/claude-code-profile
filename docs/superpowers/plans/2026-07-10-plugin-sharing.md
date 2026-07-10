# Plugin Sharing Across Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in `sharedPlugins` per profile — symlink each opted-in Claude profile's `plugins/` to a shared pool (seed-or-adopt) and union `enabledPlugins` across them, so a plugin installed/enabled on any shared profile is available and enabled on all. Manageable via CLI and the web UI.

**Architecture:** Reuses the session-sharing pool model. A `sharedPlugins` flag drives two apply actions: `share-plugins-dir` (seed the pool from the first profile, later profiles adopt it via symlink) and `set-enabled-plugins` (write the union of `enabledPlugins` into each shared profile's `settings.json`). Discovery starts reading `enabledPlugins`. CLI `plugins share/unshare` and a profile-editor checkbox expose it.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Commander, Node `http`, React/Vite/Tailwind, Vitest.

## Global Constraints

- Pool: `<manifestRoot>/shared/plugins`. Never named `.claude-*`.
- **Seed-or-adopt, NOT union-merge:** first shared profile seeds the pool (backup → copy `plugins/` into pool → symlink); later profiles adopt (backup → remove their `plugins/` → symlink to pool). Decided at execute time by whether the pool already exists. This keeps `installed_plugins.json`/`known_marketplaces.json` coherent.
- `enabledPlugins` union is **additive**: any plugin enabled on any `sharedPlugins` profile is enabled on all of them (written to each `settings.json`, preserving other keys).
- `sharedPlugins` is **Claude-only** (Codex has no plugins); planApply acts on it only for `agent === 'claude'` profiles.
- `unshare` never deletes pool data.
- Windows symlinks use `'junction'` (as other link actions do).
- `ProfileDecl = z.infer<ProfileSchema>`, so once `sharedPlugins` is added, EVERY profile object literal in `src/` and `test/` must set it (the reliable anchor: every such literal already sets `sharedSessions`). `tsc -b` excludes `test/`, so verify with a test-inclusive typecheck.
- All tests use sandboxed temp homes; never touch real `~/.claude*`.

---

### Task 1: Manifest `sharedPlugins` field + literals

**Files:**
- Modify: `packages/core/src/manifest.ts:22-34` (ProfileSchema)
- Modify: `packages/core/src/adopt.ts` (buildManifest literal), `packages/cli/src/ui/api.ts` (POST /api/profiles literal), `packages/cli/src/commands/manifest.ts` (create-command literal)
- Modify (fixtures): every `*.test.ts` profile literal that sets `sharedSessions`
- Test: `packages/core/test/manifest.test.ts`

**Interfaces:**
- Produces: `ProfileDecl.sharedPlugins: boolean` (default `false`), consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/manifest.test.ts` (mirror the existing `sharedSessions` parse case):

```ts
it('sharedPlugins parses and defaults to false', () => {
  const on = parseManifest(`
version: 1
hub: null
profiles:
  - name: a
    dir: '{home}/.claude-a'
    launcher: cl-a
    auth: env
    sharedPlugins: true
mcpServers: {}
`)
  expect(on.profiles[0].sharedPlugins).toBe(true)

  const off = parseManifest(`
version: 1
hub: null
profiles:
  - name: b
    dir: '{home}/.claude-b'
    launcher: cl-b
    auth: env
mcpServers: {}
`)
  expect(off.profiles[0].sharedPlugins).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/manifest.test.ts -t sharedPlugins`
Expected: FAIL — `sharedPlugins` is `undefined`.

- [ ] **Step 3: Add the schema field**

In `packages/core/src/manifest.ts`, in `ProfileSchema` after `sharedSessions`:

```ts
  skipPermissions: z.boolean().default(false),
  sharedSessions: z.boolean().default(false),
  sharedPlugins: z.boolean().default(false),
})
```

- [ ] **Step 4: Add `sharedPlugins: false` to every literal that sets `sharedSessions: false`**

The reliable anchor: search the repo for `sharedSessions: false` — every hit is a `ProfileDecl` literal that now also needs `sharedPlugins: false` on the following line. Apply to all of them, in both `src/` and `test/`:

```bash
grep -rln "sharedSessions: false" packages/core/src packages/cli/src packages/core/test packages/cli/test
```

Known sites (add `sharedPlugins: false` beside `sharedSessions: false` in each):
- `packages/core/src/adopt.ts` (buildManifest return object)
- `packages/cli/src/ui/api.ts` (POST `/api/profiles` push)
- `packages/cli/src/commands/manifest.ts` (create-command push)
- `packages/core/test/manifest.test.ts` (the shared `sample` literal)
- `packages/core/test/apply.test.ts` (the `manifest()` helper's profiles + any `shared sessions` describe fixtures)
- `packages/core/test/adopt.test.ts`
- `packages/core/test/codex.test.ts` (each profile literal)
- `packages/core/test/rcblock.test.ts` (each profile literal)

- [ ] **Step 5: Verify with a test-inclusive typecheck (catches any missed literal)**

`npm run build`'s `tsc -b` excludes `test/`, so also run:

```bash
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck \
  packages/core/test/manifest.test.ts packages/core/test/apply.test.ts packages/core/test/adopt.test.ts \
  packages/core/test/codex.test.ts packages/core/test/rcblock.test.ts
npx vitest run packages/core/test/manifest.test.ts -t sharedPlugins
npm run build
```
Expected: typecheck clean (no `TS2741` for `sharedPlugins`), test PASS, build clean.

- [ ] **Step 6: Commit** (stage explicit paths — do NOT `git add -A`; the tree has unrelated pre-existing untracked files and a modified `.gitignore` that must stay out)

```bash
git add packages/core/src/manifest.ts packages/core/src/adopt.ts \
  packages/cli/src/ui/api.ts packages/cli/src/commands/manifest.ts \
  packages/core/test/manifest.test.ts packages/core/test/apply.test.ts \
  packages/core/test/adopt.test.ts packages/core/test/codex.test.ts packages/core/test/rcblock.test.ts
git commit -m "feat(core): add sharedPlugins flag to profile schema"
```

---

### Task 2: Discovery reads `enabledPlugins`

**Files:**
- Modify: `packages/core/src/discovery.ts` (`LiveProfile` + the settings.json read)
- Test: `packages/core/test/discovery.test.ts`

**Interfaces:**
- Produces: `LiveProfile.enabledPlugins: Record<string, boolean>` (empty for codex / no settings.json). Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/discovery.test.ts` (match its existing setup helpers):

```ts
it('reads enabledPlugins from a profile settings.json', async () => {
  const h = await mkdtemp(join(tmpdir(), 'ccp-disc-plugins-'))
  await mkdir(join(h, '.claude-x'), { recursive: true })
  await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
  await writeFile(join(h, '.claude-x', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true, 'off@m': false } }))
  const live = await discoverProfiles(h)
  const x = live.find(p => p.dirName === '.claude-x')!
  expect(x.enabledPlugins).toEqual({ 'ponytail@ponytail': true, 'off@m': false })
})
```

(If the test file lacks `mkdtemp`/`tmpdir` imports at the top, add them there — do not add imports inside the `describe`/`it` block.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/discovery.test.ts -t enabledPlugins`
Expected: FAIL — `enabledPlugins` is `undefined` on `LiveProfile`.

- [ ] **Step 3: Add the field to `LiveProfile`**

In `packages/core/src/discovery.ts`, in the `LiveProfile` interface after `settingsEnv`:

```ts
  settingsEnv: Record<string, string>
  enabledPlugins: Record<string, boolean>
}
```

- [ ] **Step 4: Read `enabledPlugins` in `discoverProfiles`**

Find the block that reads `settings.json` for `settingsEnv` (claude only). Add an `enabledPlugins` accumulator declared next to `settingsEnv`, populate it inside the same `try`, and include it in the `out.push`:

```ts
    const settingsEnv: Record<string, string> = {}
    const enabledPlugins: Record<string, boolean> = {}
    if (agent === 'claude') try {
      const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      if (s && typeof s.env === 'object' && s.env !== null)
        for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') settingsEnv[k] = v
      if (s && typeof s.enabledPlugins === 'object' && s.enabledPlugins !== null)
        for (const [k, v] of Object.entries(s.enabledPlugins)) if (typeof v === 'boolean') enabledPlugins[k] = v
    } catch { /* no settings.json */ }
```

Then add `enabledPlugins,` to the `out.push({ ... })` object (next to `settingsEnv,`).

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run packages/core/test/discovery.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/discovery.ts packages/core/test/discovery.test.ts
git commit -m "feat(core): discovery reads enabledPlugins from settings.json"
```

---

### Task 3: Apply — plugin dir + enabledPlugins union

**Files:**
- Modify: `packages/core/src/apply.ts` (ApplyAction union, planApply, executeApply, describe)
- Test: `packages/core/test/apply.test.ts`

**Interfaces:**
- Consumes: `ProfileDecl.sharedPlugins` (Task 1), `LiveProfile.enabledPlugins` (Task 2).
- Produces: `ApplyAction` gains `{ kind: 'share-plugins-dir'; from: string; to: string }`, `{ kind: 'unshare-plugins-dir'; from: string; to: string }`, `{ kind: 'set-enabled-plugins'; settingsPath: string; enabledPlugins: Record<string, boolean> }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/apply.test.ts` (reuse its top-of-file imports — ensure `readdir`, `lstat`, `readFile` are imported at the top; do NOT add imports mid-file):

```ts
describe('shared plugins', () => {
  function pluginManifest(a: boolean, b: boolean): Manifest {
    return {
      version: 1, hub: null, mcpServers: {},
      profiles: [
        { name: 'a', dir: '{home}/.claude-a', launcher: 'cl-a', auth: 'env', env: {}, settingsEnv: {},
          links: {}, mcp: [], skipPermissions: false, sharedSessions: false, sharedPlugins: a },
        { name: 'b', dir: '{home}/.claude-b', launcher: 'cl-b', auth: 'env', env: {}, settingsEnv: {},
          links: {}, mcp: [], skipPermissions: false, sharedSessions: false, sharedPlugins: b },
      ],
    }
  }

  it('seeds the pool from the first shared profile and symlinks it', async () => {
    await mkdir(join(home, '.claude-a', 'plugins', 'cache', 'ponytail'), { recursive: true })
    await writeFile(join(home, '.claude-a', '.claude.json'), '{}')
    await writeFile(join(home, '.claude-a', 'plugins', 'installed_plugins.json'), '{"ponytail":1}')
    await mkdir(join(home, '.claude-b'), { recursive: true })
    await writeFile(join(home, '.claude-b', '.claude.json'), '{}')
    await writeFile(join(home, '.claude-b', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
    await writeFile(join(home, '.claude-a', 'settings.json'), JSON.stringify({ enabledPlugins: {} }))

    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const actions = planApply(pluginManifest(true, false), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.map(a => a.kind)).toContain('share-plugins-dir')
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })

    expect((await lstat(join(home, '.claude-a', 'plugins'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(sharedRoot, 'plugins', 'cache', 'ponytail'))).toBe(true)
  })

  it('unions enabledPlugins across shared profiles into each settings.json', async () => {
    await mkdir(join(home, '.claude-a'), { recursive: true }); await writeFile(join(home, '.claude-a', '.claude.json'), '{}')
    await mkdir(join(home, '.claude-b'), { recursive: true }); await writeFile(join(home, '.claude-b', '.claude.json'), '{}')
    await writeFile(join(home, '.claude-a', 'settings.json'), JSON.stringify({ enabledPlugins: { 'x@m': true }, keep: 1 }))
    await writeFile(join(home, '.claude-b', 'settings.json'), JSON.stringify({ enabledPlugins: { 'y@m': true } }))

    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    const actions = planApply(pluginManifest(true, true), await discoverProfiles(home), p, undefined, sharedRoot)
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't2' })

    const aCfg = JSON.parse(await readFile(join(home, '.claude-a', 'settings.json'), 'utf8'))
    expect(aCfg.enabledPlugins).toEqual({ 'x@m': true, 'y@m': true })
    expect(aCfg.keep).toBe(1) // other keys preserved
    const bCfg = JSON.parse(await readFile(join(home, '.claude-b', 'settings.json'), 'utf8'))
    expect(bCfg.enabledPlugins).toEqual({ 'x@m': true, 'y@m': true })
  })

  it('unshare restores a real plugins dir from the pool, pool intact', async () => {
    await mkdir(join(home, '.claude-a', 'plugins'), { recursive: true }); await writeFile(join(home, '.claude-a', '.claude.json'), '{}')
    await writeFile(join(home, '.claude-a', 'settings.json'), '{}')
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const sharedRoot = join(home, '.ccprofiles', 'shared')
    await executeApply(planApply(pluginManifest(true, false), await discoverProfiles(home), p, undefined, sharedRoot),
      { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    await writeFile(join(sharedRoot, 'plugins', 'marker.txt'), 'hi')

    const actions = planApply(pluginManifest(false, false), await discoverProfiles(home), p, undefined, sharedRoot)
    expect(actions.map(a => a.kind)).toContain('unshare-plugins-dir')
    await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't2' })
    expect((await lstat(join(home, '.claude-a', 'plugins'))).isSymbolicLink()).toBe(false)
    expect(existsSync(join(home, '.claude-a', 'plugins', 'marker.txt'))).toBe(true)
    expect(existsSync(join(sharedRoot, 'plugins', 'marker.txt'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/apply.test.ts -t "shared plugins"`
Expected: FAIL — no `share-plugins-dir`/`set-enabled-plugins` actions.

- [ ] **Step 3: Extend the ApplyAction union**

In `packages/core/src/apply.ts`, after the `unshare-session-dir` member:

```ts
  | { kind: 'unshare-session-dir'; from: string; to: string }
  | { kind: 'share-plugins-dir'; from: string; to: string }
  | { kind: 'unshare-plugins-dir'; from: string; to: string }
  | { kind: 'set-enabled-plugins'; settingsPath: string; enabledPlugins: Record<string, boolean> }
```

- [ ] **Step 4: planApply — plugin link + enabledPlugins union**

Near the top of `planApply` (after `const hubProfile = ...`), compute the union:

```ts
  const pluginUnion: Record<string, boolean> = {}
  for (const pr of m.profiles) {
    if ((pr.agent ?? 'claude') !== 'claude' || !pr.sharedPlugins) continue
    const lp = live.find(l => l.dir === renderPath(pr.dir, p))
    for (const [k, v] of Object.entries(lp?.enabledPlugins ?? {})) if (v) pluginUnion[k] = true
  }
```

Inside the `for (const pr of m.profiles)` loop, after the existing shared-sessions block (the `for (const entry of sharedEntries)` loop), add:

```ts
    if (agent === 'claude') {
      const pfrom = join(dir, 'plugins')
      const pto = join(sharedRoot, 'plugins')
      const pluginLinked = lp?.links['plugins'] === pto
      if (pr.sharedPlugins && !pluginLinked) actions.push({ kind: 'share-plugins-dir', from: pfrom, to: pto })
      else if (!pr.sharedPlugins && pluginLinked) actions.push({ kind: 'unshare-plugins-dir', from: pfrom, to: pto })

      if (pr.sharedPlugins) {
        const currentEnabled = lp?.enabledPlugins ?? {}
        if (JSON.stringify(sortKeys(currentEnabled)) !== JSON.stringify(sortKeys(pluginUnion)))
          actions.push({ kind: 'set-enabled-plugins', settingsPath: join(dir, 'settings.json'), enabledPlugins: pluginUnion })
      }
    }
```

(`agent`, `dir`, `lp`, `sharedRoot`, `sortKeys` are all already in scope in that loop.)

- [ ] **Step 5: executeApply — the three handlers**

Add to the backup `touched` list (in the `.flatMap`), alongside the existing kinds:

```ts
    : a.kind === 'set-settings-env' ? [a.settingsPath]
    : a.kind === 'set-enabled-plugins' ? [a.settingsPath]
```

Add the action handlers inside the loop (after the `unshare-session-dir` branch):

```ts
    } else if (a.kind === 'share-plugins-dir') {
      const poolExists = existsSync(a.to)
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try { st = await lstat(a.from) } catch { /* absent */ }
      if (st && st.isSymbolicLink()) {
        await unlink(a.from)
      } else if (st) {
        await backupTree(a.from, opts.backupRoot, opts.stamp)
        if (!poolExists) { await mkdir(dirname(a.to), { recursive: true }); await cp(a.from, a.to, { recursive: true }) } // seed
        await rm(a.from, { recursive: true, force: true })                                                             // adopt = no copy
      }
      if (!existsSync(a.to)) await mkdir(a.to, { recursive: true })
      await mkdir(dirname(a.from), { recursive: true })
      await symlink(a.to, a.from, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (a.kind === 'unshare-plugins-dir') {
      try { const st = await lstat(a.from); if (st.isSymbolicLink()) await unlink(a.from) } catch { /* absent */ }
      await mkdir(a.from, { recursive: true })
      if (existsSync(a.to)) await cp(a.to, a.from, { recursive: true, force: false, errorOnExist: false })
    } else if (a.kind === 'set-enabled-plugins') {
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(await readFile(a.settingsPath, 'utf8')) } catch { /* new file */ }
      cfg.enabledPlugins = a.enabledPlugins
      await mkdir(dirname(a.settingsPath), { recursive: true })
      await atomicWrite(a.settingsPath, JSON.stringify(cfg, null, 2))
```

(`cp`, `rm`, `lstat`, `unlink`, `symlink`, `mkdir`, `readFile`, `existsSync`, `dirname`, `backupTree`, `atomicWrite` are all already imported in `apply.ts`.)

- [ ] **Step 6: describe() cases**

In `describe()` after `unshare-session-dir`:

```ts
    case 'share-plugins-dir': return `share plugins ${a.from} -> ${a.to}`
    case 'unshare-plugins-dir': return `unshare plugins ${a.from} (seed from ${a.to})`
    case 'set-enabled-plugins': return `set enabledPlugins (${Object.keys(a.enabledPlugins).length}) in ${a.settingsPath}`
```

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run packages/core/test/apply.test.ts && npm run build`
Expected: all apply tests PASS (existing + new); build clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/apply.ts packages/core/test/apply.test.ts
git commit -m "feat(core): share-plugins-dir + enabledPlugins union apply actions"
```

---

### Task 4: CLI `plugins` command

**Files:**
- Create: `packages/cli/src/commands/plugins.ts`
- Modify: `packages/cli/src/context.ts` (register)
- Test: `packages/cli/test/plugins.test.ts`

**Interfaces:**
- Consumes: `planActions` (plan.ts), `executeApply`, `saveManifest` (core), `requireManifest` (context).
- Produces: `registerPluginCommands(program, ctx)`; verbs `plugins share <profile>` / `plugins unshare <profile>`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/plugins.test.ts` (follow `packages/cli/test/sessions.test.ts`):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-plugins-'))
  await mkdir(join(home, '.claude', 'plugins', 'cache', 'ponytail'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }))
})

function run(...args: string[]): Promise<void> {
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('plugins cli', () => {
  it('share links the profile plugins dir into the pool and unions enabled plugins', async () => {
    await run('adopt', '--yes')
    await run('plugins', 'share', 'default')
    expect((await lstat(join(home, '.claude', 'plugins'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, '.ccprofiles', 'shared', 'plugins', 'cache', 'ponytail'))).toBe(true)
    const cfg = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(cfg.enabledPlugins['ponytail@ponytail']).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/test/plugins.test.ts`
Expected: FAIL — `plugins` is not a known command.

- [ ] **Step 3: Create `packages/cli/src/commands/plugins.ts`**

```ts
import type { Command } from 'commander'
import { executeApply, saveManifest } from 'ccprofiles-core'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerPluginCommands(program: Command, ctx: CliContext): void {
  const plugins = program.command('plugins').description('share Claude Code plugins across profiles')

  async function setShared(name: string, on: boolean): Promise<void> {
    const m = await requireManifest(ctx)
    const pr = m.profiles.find(p => p.name === name)
    if (!pr) throw new Error(`unknown profile: ${name}`)
    pr.sharedPlugins = on
    await saveManifest(ctx.manifestRoot, m)
    const actions = await planActions(ctx, m)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
    for (const line of r.performed) console.log(line)
  }

  plugins.command('share <profile>').description("pool this profile's plugins with other shared profiles")
    .action((name: string) => setShared(name, true))
  plugins.command('unshare <profile>').description('stop sharing; keep a local snapshot of the pool')
    .action((name: string) => setShared(name, false))
}
```

- [ ] **Step 4: Register in `packages/cli/src/context.ts`**

Add the import (with the other `register*` imports):

```ts
import { registerPluginCommands } from './commands/plugins.js'
```

Call it in `buildProgram` (after `registerSessionCommands(program, ctx)`):

```ts
  registerSessionCommands(program, ctx)
  registerPluginCommands(program, ctx)
```

- [ ] **Step 5: Run tests + build + full suite**

Run: `npx vitest run packages/cli/test/plugins.test.ts && npm run build && npx vitest run`
Expected: plugins test PASS; build clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/plugins.ts packages/cli/src/context.ts packages/cli/test/plugins.test.ts
git commit -m "feat(cli): plugins share/unshare command"
```

---

### Task 5: UI — API field + profile-editor toggle

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (GET row, PATCH, POST default)
- Modify: `packages/ui/src/components/ProfileEditor.tsx` (`ProfileRow` field + checkbox + patch)
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Consumes: `sharedPlugins` (schema). Produces: profile rows include `sharedPlugins`; PATCH accepts it; editor toggles it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/ui-api-core.test.ts` (reuse its `callApi` helper; mirror the existing `sharedSessions` tests exactly for the response-shape convention):

```ts
it('PATCH sharedPlugins sets the flag and GET returns it', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedPlugins: true })
  expect(res._status).toBe(200)
  const rows = (await callApi(ctx, 'GET', '/api/profiles'))._json
  expect(rows.find((r: any) => r.name === 'default').sharedPlugins).toBe(true)
})

it('PATCH sharedPlugins rejects a non-boolean', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedPlugins: 'yes' })
  expect(res._status).toBe(400)
})
```

(Match `_status`/`_json` to whatever the file's `callApi` actually returns — copy the shape from the adjacent `sharedSessions` tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts -t sharedPlugins`
Expected: FAIL — PATCH ignores `sharedPlugins`; GET row lacks it.

- [ ] **Step 3: Add `sharedPlugins` to the GET row + POST default + PATCH**

In `packages/cli/src/ui/api.ts`:

GET `/api/profiles` row object — after `sharedSessions: decl?.sharedSessions ?? false,`:

```ts
        sharedSessions: decl?.sharedSessions ?? false,
        sharedPlugins: decl?.sharedPlugins ?? false,
      }
```

POST `/api/profiles` push literal — after `sharedSessions: false,`:

```ts
      sharedSessions: false,
      sharedPlugins: false,
    })
```

PATCH body type — extend it with `sharedPlugins?: boolean`, then add handling after the `sharedSessions` block:

```ts
    if (body.sharedPlugins !== undefined) {
      if (typeof body.sharedPlugins !== 'boolean') throw new HttpError(400, 'sharedPlugins must be a boolean')
      pr.sharedPlugins = body.sharedPlugins
    }
```

- [ ] **Step 4: Add the toggle to `packages/ui/src/components/ProfileEditor.tsx`**

The exact lines have shifted from earlier versions, so integrate by mirroring `sharedSessions`:
- `ProfileRow` type: after `sharedSessions: boolean` add `sharedPlugins: boolean`.
- State: after the `sharedSessions` `useState`, add `const [sharedPlugins, setSharedPlugins] = useState(profile.sharedPlugins)`.
- The `patchProfile` call: add `sharedPlugins,` next to `sharedSessions,`.
- The checkbox: duplicate the `sharedSessions` checkbox block (it is NOT launcher-gated) and change label/state to plugins, e.g.:

```tsx
<label className="flex items-center gap-2 text-sm">
  <input type="checkbox" checked={sharedPlugins} onChange={e => setSharedPlugins(e.target.checked)} />
  Share plugins (pool <span className="font-mono text-xs">plugins/</span> + enabled plugins with other shared profiles)
</label>
```

- [ ] **Step 5: Build the UI + full suite**

Run: `npm run build && npx vitest run`
Expected: `vite build` type-checks clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/test/ui-api-core.test.ts packages/ui/src/components/ProfileEditor.tsx
git commit -m "feat(ui): sharedPlugins on profiles API + editor toggle"
```

---

## Verification (end of plan)

- [ ] `npm run build` — clean.
- [ ] `npx vitest run` — full suite green.
- [ ] Sandbox manual check per `.claude/skills/verify/SKILL.md`: adopt two claude profiles, install/seed plugins under one, `plugins share <that> ` then `plugins share <other>` → both `plugins/` are symlinks to `<manifestRoot>/shared/plugins`, and each `settings.json` has the union `enabledPlugins`. `plugins unshare <other>` restores a real dir while the pool remains. In `clp ui`, the profile editor's **Share plugins** checkbox round-trips.

## Notes / limitations (from the spec)

- Seed-or-adopt: share your plugin-rich profile first; others adopt its set (no multi-profile plugin merge).
- `enabledPlugins` union is additive (a plugin enabled anywhere is enabled everywhere among shared profiles).
- `data/` (plugin runtime state) is shared as part of the dir.
- Claude-only; Codex has no plugins.
