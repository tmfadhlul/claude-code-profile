# Plugins v2 — MCP-style per-profile management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shipped symlink/union plugin-sharing with an MCP-style plugin × profile matrix: per-profile `plugins: string[]`, reconciled by driving the official `claude plugin` CLI per profile. Manageable via CLI and the dashboard.

**Architecture:** Revert the `sharedPlugins`/symlink feature. Add a `marketplaces` registry + per-profile `plugins` list to the manifest (mirroring `mcpServers` + `mcp`). A pure `plugins.ts` reconciler diffs desired-vs-current and drives an injectable `PluginRunner`; the CLI's real runner shells out to `claude plugin install/uninstall/marketplace add` with `CLAUDE_CONFIG_DIR` set. CLI `plugins list/add/rm/sync` + a dashboard matrix page mirror the MCP command and page.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Commander, Node `child_process.spawn`, React/Vite/Tailwind, Vitest.

## Global Constraints

- Plugin id format: `"<name>@<marketplace>"`. `marketplaces` maps marketplace name → `{ source: string }` (e.g. `"DietrichGebert/ponytail"`).
- Every profile plugin id `x@mkt` must have `mkt` present in `manifest.marketplaces` (validated like "undefined mcp server").
- `assertSafeManifest` (these are interpolated into a shelled command): marketplace name matches `SAFE_NAME` (`^[A-Za-z0-9_-]+$`); source matches `^[A-Za-z0-9._/@:-]+$`; a plugin id splits on the LAST `@` into name + marketplace, both matching `SAFE_NAME`.
- Reconcile drives the official CLI only — NO plugin file copying/symlinking. Real runner: `spawn('claude', ['plugin', ...], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })`; `claude` missing → clear error.
- Reconcile is NOT part of `planApply`/`executeApply` (those stay pure/offline); it runs from the `plugins` commands + UI.
- `ProfileDecl = z.infer<ProfileSchema>`: after the schema changes, EVERY profile literal in `src/` + `test/` must match (anchor: literals currently set `sharedPlugins: false` — Task 1 removes that; Task 2 adds nothing required since `plugins` defaults). Verify with a test-inclusive typecheck.
- Tests never invoke the real `claude` binary (inject a fake `PluginRunner`).
- All tests use sandboxed temp homes.

---

### Task 1: Revert the shipped symlink plugin-sharing

Remove everything the `sharedPlugins` feature added, leaving a clean, green tree. Keep `discovery.enabledPlugins` (reused later).

**Files (all touched by the shipped feature):**
- `packages/core/src/manifest.ts` (remove `sharedPlugins` field)
- `packages/core/src/apply.ts` (remove `share-plugins-dir`/`unshare-plugins-dir`/`set-enabled-plugins`: union member, planApply block + `pluginUnion`, executeApply handlers, `describe()` cases, backup `touched` entry)
- `packages/core/src/adopt.ts` (remove `sharedPlugins: false`)
- `packages/cli/src/commands/manifest.ts` (remove `sharedPlugins: false` from its create literal)
- `packages/cli/src/ui/api.ts` (remove `sharedPlugins` from GET row, PATCH body type + handler, POST literal)
- `packages/cli/src/commands/plugins.ts` (delete file — replaced in Task 5)
- `packages/cli/src/context.ts` (remove `registerPluginCommands` import + call — re-added in Task 5)
- `packages/ui/src/components/ProfileEditor.tsx` (remove `sharedPlugins` from `ProfileRow`, state, `patchProfile`, and the Plugins toggle block)
- Tests: remove the `describe('shared plugins', …)` block in `packages/core/test/apply.test.ts`; delete `packages/cli/test/plugins.test.ts`; remove `sharedPlugins` cases in `packages/cli/test/ui-api-core.test.ts`; drop `sharedPlugins: false` from every remaining ProfileDecl literal.

- [ ] **Step 1: Find every reference**

```bash
grep -rn "sharedPlugins\|share-plugins-dir\|unshare-plugins-dir\|set-enabled-plugins\|registerPluginCommands\|pluginUnion" packages/core/src packages/cli/src packages/ui/src packages/core/test packages/cli/test
```

- [ ] **Step 2: Remove all of it**

Delete each reference so the symbol `sharedPlugins` and the three action kinds no longer exist anywhere. Delete `packages/cli/src/commands/plugins.ts` and `packages/cli/test/plugins.test.ts` entirely. In `context.ts` remove the import and the `registerPluginCommands(program, ctx)` call. Leave `discovery.ts`'s `enabledPlugins` intact.

- [ ] **Step 3: Verify clean removal**

```bash
grep -rn "sharedPlugins\|share-plugins-dir\|unshare-plugins-dir\|set-enabled-plugins\|pluginUnion" packages/ ; echo "exit: $?"
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck \
  packages/core/test/apply.test.ts packages/core/test/manifest.test.ts packages/core/test/adopt.test.ts \
  packages/core/test/codex.test.ts packages/core/test/rcblock.test.ts packages/core/test/assets.test.ts
npm run build && npx vitest run
```
Expected: first grep prints nothing (exit 1 = no matches); typecheck clean; build clean; full suite green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/apply.ts packages/core/src/adopt.ts \
  packages/cli/src/commands/manifest.ts packages/cli/src/ui/api.ts packages/cli/src/context.ts \
  packages/ui/src/components/ProfileEditor.tsx packages/core/test/apply.test.ts \
  packages/cli/test/ui-api-core.test.ts packages/core/test/manifest.test.ts packages/core/test/adopt.test.ts \
  packages/core/test/codex.test.ts packages/core/test/rcblock.test.ts packages/core/test/assets.test.ts
git rm packages/cli/src/commands/plugins.ts packages/cli/test/plugins.test.ts
git commit -m "revert: remove symlink/union plugin sharing (replaced by MCP-style model)"
```

---

### Task 2: Manifest — `plugins[]` + `marketplaces` registry

**Files:**
- Modify: `packages/core/src/manifest.ts` (ProfileSchema, ManifestSchema, parse validation, assertSafeManifest)
- Test: `packages/core/test/manifest.test.ts`

**Interfaces:**
- Produces: `ProfileDecl.plugins: string[]` (default `[]`); `Manifest.marketplaces: Record<string, { source: string }>`; `MarketplaceDef` type. Consumed by Tasks 3-7.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/manifest.test.ts`:

```ts
it('parses plugins[] and marketplaces registry, defaults plugins to []', () => {
  const m = parseManifest(`
version: 1
hub: null
profiles:
  - name: a
    dir: '{home}/.claude-a'
    launcher: cl-a
    auth: env
    plugins: [ 'ponytail@ponytail' ]
mcpServers: {}
marketplaces:
  ponytail: { source: 'DietrichGebert/ponytail' }
`)
  expect(m.profiles[0].plugins).toEqual(['ponytail@ponytail'])
  expect(m.marketplaces.ponytail.source).toBe('DietrichGebert/ponytail')

  const d = parseManifest(`
version: 1
hub: null
profiles:
  - { name: b, dir: '{home}/.claude-b', launcher: cl-b, auth: env }
mcpServers: {}
`)
  expect(d.profiles[0].plugins).toEqual([])
  expect(d.marketplaces).toEqual({})
})

it('rejects a plugin id whose marketplace is not in the registry', () => {
  expect(() => parseManifest(`
version: 1
hub: null
profiles:
  - { name: a, dir: '{home}/.claude-a', launcher: cl-a, auth: env, plugins: [ 'x@nope' ] }
mcpServers: {}
marketplaces: {}
`)).toThrow(/undefined marketplace|nope/)
})

it('assertSafeManifest rejects an unsafe marketplace source', () => {
  expect(() => parseManifest(`
version: 1
hub: null
profiles: []
mcpServers: {}
marketplaces:
  bad: { source: 'a; rm -rf ~' }
`)).toThrow(/unsafe/)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/core/test/manifest.test.ts -t "plugins\|marketplace"`
Expected: FAIL.

- [ ] **Step 3: Schema + validation**

In `packages/core/src/manifest.ts`:

Add to `ProfileSchema` (after `sharedSessions`, since Task 1 removed `sharedPlugins`):

```ts
  sharedSessions: z.boolean().default(false),
  plugins: z.array(z.string()).default([]),
})
```

Add a marketplace schema + extend `ManifestSchema`:

```ts
const MarketplaceSchema = z.object({ source: z.string().min(1) })

const ManifestSchema = z.object({
  version: z.literal(1),
  hub: z.string().nullable(),
  profiles: z.array(ProfileSchema),
  mcpServers: z.record(McpServerSchema),
  marketplaces: z.record(MarketplaceSchema).default({}),
})

export type MarketplaceDef = z.infer<typeof MarketplaceSchema>
```

In `parseManifest`, after the existing mcp-reference check, add the marketplace-reference check:

```ts
  for (const p of m.profiles) for (const id of p.plugins) {
    const at = id.lastIndexOf('@')
    const mkt = at > 0 ? id.slice(at + 1) : ''
    if (!mkt || !m.marketplaces[mkt]) throw new ManifestError(`profile "${p.name}" references undefined marketplace for plugin "${id}"`)
  }
```

In `assertSafeManifest`, add (a `PLUGIN`/`SOURCE` safety pass) near the profile loop:

```ts
const SAFE_SOURCE = /^[A-Za-z0-9._/@:-]+$/
```

```ts
  for (const [name, mk] of Object.entries(m.marketplaces ?? {})) {
    if (!SAFE_NAME.test(name)) throw new ManifestError(`unsafe marketplace name: ${JSON.stringify(name)}`)
    if (!SAFE_SOURCE.test(mk.source)) throw new ManifestError(`unsafe marketplace source for "${name}": ${JSON.stringify(mk.source)}`)
  }
  for (const p of m.profiles) for (const id of p.plugins) {
    const at = id.lastIndexOf('@')
    const nm = at > 0 ? id.slice(0, at) : id, mkt = at > 0 ? id.slice(at + 1) : ''
    if (!SAFE_NAME.test(nm) || !SAFE_NAME.test(mkt)) throw new ManifestError(`unsafe plugin id in profile "${p.name}": ${JSON.stringify(id)}`)
  }
```

- [ ] **Step 4: Fix literals**

`ProfileDecl` gains `plugins` (defaults `[]`, so object literals in tests need it only if `strict` output type flags it — `z.array().default([])` makes it required in the OUTPUT type). Add `plugins: []` to every ProfileDecl literal (same anchor set Task 1 touched). Add `marketplaces: {}` to every `Manifest` literal (e.g. in `apply.test.ts`, `codex.test.ts`, `rcblock.test.ts`, `adopt.ts` buildManifest return, cli create literals, ui/api POST literal). Verify with the test-inclusive typecheck from Task 1 Step 3.

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npx vitest run packages/core/test/manifest.test.ts && npm run build && npx vitest run`
Expected: new tests PASS; build clean; suite green.

- [ ] **Step 6: Commit**

```bash
git add -u && git reset -q .gitignore
git commit -m "feat(core): manifest plugins[] + marketplaces registry"
```
(`git add -u` stages tracked modifications only — no untracked AGENTS.md/CLAUDE.md — and the `git reset -q .gitignore` keeps the pre-existing CCE `.gitignore` change out.)

---

### Task 3: Discovery — marketplaces

**Files:**
- Modify: `packages/core/src/discovery.ts` (`LiveProfile.marketplaces`)
- Test: `packages/core/test/discovery.test.ts`

**Interfaces:**
- Produces: `LiveProfile.marketplaces: Record<string, { source: string }>` (from `known_marketplaces.json`; `{}` for codex / missing). Consumed by Task 5 (adopt).

- [ ] **Step 1: Write the failing test**

```ts
it('reads marketplaces from known_marketplaces.json', async () => {
  const h = await mkdtemp(join(tmpdir(), 'ccp-disc-mkt-'))
  await mkdir(join(h, '.claude-x', 'plugins'), { recursive: true })
  await writeFile(join(h, '.claude-x', '.claude.json'), '{}')
  await writeFile(join(h, '.claude-x', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } } }))
  const live = await discoverProfiles(h)
  const x = live.find(p => p.dirName === '.claude-x')!
  expect(x.marketplaces).toEqual({ ponytail: { source: 'DietrichGebert/ponytail' } })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/core/test/discovery.test.ts -t marketplaces`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `LiveProfile` (after `enabledPlugins`):

```ts
  enabledPlugins: Record<string, boolean>
  marketplaces: Record<string, { source: string }>
```

In `discoverProfiles`, near the settings.json read (claude only), read `known_marketplaces.json`:

```ts
    const marketplaces: Record<string, { source: string }> = {}
    if (agent === 'claude') try {
      const km = JSON.parse(await readFile(join(dir, 'plugins', 'known_marketplaces.json'), 'utf8'))
      if (km && typeof km === 'object') for (const [name, v] of Object.entries<any>(km)) {
        const repo = v?.source?.repo
        if (typeof repo === 'string') marketplaces[name] = { source: repo }
      }
    } catch { /* no plugins/known_marketplaces.json */ }
```

Add `marketplaces,` to the `out.push({...})`.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run packages/core/test/discovery.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/discovery.ts packages/core/test/discovery.test.ts
git commit -m "feat(core): discovery reads plugin marketplaces"
```

---

### Task 4: Core reconciler (`plugins.ts`)

**Files:**
- Create: `packages/core/src/plugins.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/plugins.test.ts`

**Interfaces:**
- Produces:
  - `PluginRunner` interface: `{ marketplaceAdd(configDir, source): Promise<void>; install(configDir, id): Promise<void>; uninstall(configDir, id): Promise<void> }`
  - `planPluginReconcile(desired: string[], current: string[]): { install: string[]; uninstall: string[] }`
  - `marketplaceOf(id: string): string | null`
  - `reconcileProfilePlugins(opts: { configDir: string; desired: string[]; current: string[]; marketplaces: Record<string, { source: string }>; runner: PluginRunner }): Promise<string[]>`
  - `restoreLegacyPluginSymlink(pluginsDir: string): Promise<boolean>`
  - Consumed by Tasks 5-6.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/plugins.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPluginReconcile, marketplaceOf, reconcileProfilePlugins, restoreLegacyPluginSymlink, type PluginRunner } from '../src/plugins.js'

describe('planPluginReconcile', () => {
  it('diffs desired vs current', () => {
    expect(planPluginReconcile(['a@m', 'b@m'], ['b@m', 'c@m'])).toEqual({ install: ['a@m'], uninstall: ['c@m'] })
  })
})

describe('marketplaceOf', () => {
  it('takes the part after the last @', () => {
    expect(marketplaceOf('claude-mem@thedotmack')).toBe('thedotmack')
    expect(marketplaceOf('bare')).toBeNull()
  })
})

function fakeRunner() {
  const calls: string[] = []
  const runner: PluginRunner = {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
  }
  return { runner, calls }
}

describe('reconcileProfilePlugins', () => {
  it('adds each new marketplace once, installs new, uninstalls removed', async () => {
    const { runner, calls } = fakeRunner()
    await reconcileProfilePlugins({
      configDir: '/cfg',
      desired: ['ponytail@ponytail', 'claude-mem@thedotmack'],
      current: ['old@thedotmack'],
      marketplaces: { ponytail: { source: 'o/ponytail' }, thedotmack: { source: 'o/cm' } },
      runner,
    })
    // uninstall first, then marketplace-add (once per new mkt) + install
    expect(calls).toEqual([
      'uninstall old@thedotmack',
      'add o/ponytail', 'install ponytail@ponytail',
      'add o/cm', 'install claude-mem@thedotmack',
    ])
  })

  it('does not re-add a marketplace already needed twice', async () => {
    const { runner, calls } = fakeRunner()
    await reconcileProfilePlugins({
      configDir: '/cfg', desired: ['a@m', 'b@m'], current: [],
      marketplaces: { m: { source: 'o/m' } }, runner,
    })
    expect(calls.filter(c => c === 'add o/m').length).toBe(1)
  })
})

describe('restoreLegacyPluginSymlink', () => {
  let home: string
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-legacy-')) })
  it('replaces a symlinked plugins/ with a real dir copied from the pool', async () => {
    const pool = join(home, 'pool'); await mkdir(pool, { recursive: true })
    await writeFile(join(pool, 'x.txt'), 'hi')
    const pdir = join(home, '.claude-a', 'plugins')
    await mkdir(join(home, '.claude-a'), { recursive: true })
    await symlink(pool, pdir, 'dir')
    const changed = await restoreLegacyPluginSymlink(pdir)
    expect(changed).toBe(true)
    expect((await lstat(pdir)).isSymbolicLink()).toBe(false)
    expect(existsSync(join(pdir, 'x.txt'))).toBe(true)
  })
  it('returns false for a real dir', async () => {
    const pdir = join(home, '.claude-b', 'plugins'); await mkdir(pdir, { recursive: true })
    expect(await restoreLegacyPluginSymlink(pdir)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/core/test/plugins.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `packages/core/src/plugins.ts`**

```ts
import { cp, lstat, mkdir, readlink, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface PluginRunner {
  marketplaceAdd(configDir: string, source: string): Promise<void>
  install(configDir: string, id: string): Promise<void>
  uninstall(configDir: string, id: string): Promise<void>
}

export function marketplaceOf(id: string): string | null {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(at + 1) : null
}

export function planPluginReconcile(desired: string[], current: string[]): { install: string[]; uninstall: string[] } {
  const d = new Set(desired), c = new Set(current)
  return { install: desired.filter(id => !c.has(id)), uninstall: current.filter(id => !d.has(id)) }
}

export async function reconcileProfilePlugins(opts: {
  configDir: string
  desired: string[]
  current: string[]
  marketplaces: Record<string, { source: string }>
  runner: PluginRunner
}): Promise<string[]> {
  const log: string[] = []
  const { install, uninstall } = planPluginReconcile(opts.desired, opts.current)
  for (const id of uninstall) { await opts.runner.uninstall(opts.configDir, id); log.push(`uninstall ${id}`) }
  const added = new Set<string>()
  for (const id of install) {
    const mkt = marketplaceOf(id)
    if (mkt && !added.has(mkt)) {
      const src = opts.marketplaces[mkt]?.source
      if (src) { await opts.runner.marketplaceAdd(opts.configDir, src); added.add(mkt); log.push(`add ${src}`) }
    }
    await opts.runner.install(opts.configDir, id); log.push(`install ${id}`)
  }
  return log
}

/** If a profile's plugins/ is a legacy symlink into the old shared pool, restore it to a real dir. */
export async function restoreLegacyPluginSymlink(pluginsDir: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof lstat>> | null = null
  try { st = await lstat(pluginsDir) } catch { return false }
  if (!st.isSymbolicLink()) return false
  const target = await readlink(pluginsDir)
  await unlink(pluginsDir)
  await mkdir(pluginsDir, { recursive: true })
  if (existsSync(target)) await cp(target, pluginsDir, { recursive: true, force: false, errorOnExist: false })
  return true
}
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

```ts
export * from './plugins.js'
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run packages/core/test/plugins.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins.ts packages/core/src/index.ts packages/core/test/plugins.test.ts
git commit -m "feat(core): plugin reconciler (planner + runner iface + legacy restore)"
```

---

### Task 5: CLI `plugins list/add/rm/sync` + real runner + adopt

**Files:**
- Create: `packages/cli/src/commands/plugins.ts`
- Modify: `packages/cli/src/context.ts` (register + optional `pluginRunner` seam), `packages/core/src/adopt.ts` (buildManifest builds `marketplaces` + per-profile `plugins`)
- Test: `packages/cli/test/plugins.test.ts`

**Interfaces:**
- Consumes: `planPluginReconcile`/`reconcileProfilePlugins`/`restoreLegacyPluginSymlink`/`PluginRunner` (core), `requireManifest`/`saveManifest`, `discoverProfiles`.
- Produces: `registerPluginCommands(program, ctx)`; `CliContext.pluginRunner?: PluginRunner` test seam. Verbs `plugins list/add/rm/sync`.

- [ ] **Step 1: Write the failing test** (inject a fake runner via ctx)

Create `packages/cli/test/plugins.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'
import { loadManifest, type PluginRunner } from 'ccprofiles-core'

let home: string, calls: string[]
function fake(): PluginRunner {
  return {
    marketplaceAdd: async (_d, s) => { calls.push(`add ${s}`) },
    install: async (_d, id) => { calls.push(`install ${id}`) },
    uninstall: async (_d, id) => { calls.push(`uninstall ${id}`) },
  }
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-plugins-')); calls = []
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } } }))
})
function run(...args: string[]): Promise<void> {
  const ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any), pluginRunner: fake() }
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('plugins cli', () => {
  it('add installs on the target profile and records it in the manifest', async () => {
    await run('adopt', '--yes')
    await run('plugins', 'add', 'ponytail@ponytail', '--profile', 'default')
    expect(calls).toContain('install ponytail@ponytail')
    const m = await loadManifest(join(home, '.ccprofiles'))
    expect(m.profiles.find(p => p.name === 'default')!.plugins).toContain('ponytail@ponytail')
    expect(m.marketplaces.ponytail.source).toBe('DietrichGebert/ponytail')
  })

  it('add errors for an unknown marketplace without --marketplace', async () => {
    await run('adopt', '--yes')
    await expect(run('plugins', 'add', 'x@nope', '--profile', 'default')).rejects.toThrow(/marketplace/)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/cli/test/plugins.test.ts`
Expected: FAIL — `plugins` unknown / `pluginRunner` unused.

- [ ] **Step 3: `pluginRunner` seam in `packages/cli/src/context.ts`**

Add to `CliContext`:

```ts
  env: NodeJS.ProcessEnv
  pluginRunner?: import('ccprofiles-core').PluginRunner
}
```
(makeContext leaves it undefined; the command falls back to the real runner.)

- [ ] **Step 4: Create `packages/cli/src/commands/plugins.ts`**

```ts
import type { Command } from 'commander'
import {
  discoverProfiles, saveManifest, reconcileProfilePlugins, restoreLegacyPluginSymlink,
  renderPath, type PluginRunner, type Manifest,
} from 'ccprofiles-core'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { requireManifest, type CliContext } from '../context.js'

function claudeRunner(): PluginRunner {
  const run = (configDir: string, args: string[]) => new Promise<void>((resolve, reject) => {
    const p = spawn('claude', ['plugin', ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr?.on('data', d => { err += d })
    p.on('error', e => reject(new Error(`could not run 'claude' — is Claude Code on PATH? (${e.message})`)))
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `claude plugin ${args.join(' ')} exited ${code}`)))
  })
  return {
    // marketplace add tolerates an already-added marketplace (install will fail clearly if truly missing)
    marketplaceAdd: (cd, source) => run(cd, ['marketplace', 'add', source]).catch(() => {}),
    install: (cd, id) => run(cd, ['install', id]),
    uninstall: (cd, id) => run(cd, ['uninstall', id]),
  }
}

function targets(m: Manifest, opts: { profile?: string; all?: boolean }): string[] {
  if (opts.all) return m.profiles.filter(p => (p.agent ?? 'claude') === 'claude').map(p => p.name)
  if (!opts.profile) throw new Error('specify --profile <name> or --all')
  if (!m.profiles.some(p => p.name === opts.profile)) throw new Error(`unknown profile: ${opts.profile}`)
  return [opts.profile]
}

export function registerPluginCommands(program: Command, ctx: CliContext): void {
  const plugins = program.command('plugins').description('manage Claude Code plugins across profiles')

  async function reconcile(m: Manifest, names: string[]): Promise<void> {
    const runner = ctx.pluginRunner ?? claudeRunner()
    const live = await discoverProfiles(ctx.home)
    for (const name of names) {
      const pr = m.profiles.find(p => p.name === name)!
      if ((pr.agent ?? 'claude') !== 'claude') continue
      const dir = renderPath(pr.dir, ctx.platform)
      await restoreLegacyPluginSymlink(join(dir, 'plugins'))
      const lp = live.find(l => l.dir === dir)
      const current = Object.entries(lp?.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k)
      const log = await reconcileProfilePlugins({ configDir: dir, desired: pr.plugins, current, marketplaces: m.marketplaces, runner })
      for (const line of log) console.log(`${name}: ${line}`)
    }
  }

  plugins.command('list').action(async () => {
    const m = await requireManifest(ctx)
    const ids = [...new Set(m.profiles.flatMap(p => p.plugins))].sort()
    const claude = m.profiles.filter(p => (p.agent ?? 'claude') === 'claude')
    console.log(' '.repeat(28) + claude.map(p => p.name.padEnd(10)).join(''))
    for (const id of ids) console.log(id.padEnd(28) + claude.map(p => (p.plugins.includes(id) ? 'x' : '.').padEnd(10)).join(''))
  })

  plugins.command('add <id>')
    .option('--profile <p>').option('--all').option('--marketplace <source>')
    .action(async (id: string, opts: any) => {
      const m = await requireManifest(ctx)
      const at = id.lastIndexOf('@'); const mkt = at > 0 ? id.slice(at + 1) : ''
      if (!mkt) throw new Error(`plugin id must be name@marketplace: ${id}`)
      if (!m.marketplaces[mkt]) {
        if (!opts.marketplace) throw new Error(`unknown marketplace "${mkt}" — pass --marketplace <source> to define it`)
        m.marketplaces[mkt] = { source: opts.marketplace }
      }
      const names = targets(m, opts)
      for (const t of names) { const pr = m.profiles.find(p => p.name === t)!; if (!pr.plugins.includes(id)) pr.plugins.push(id) }
      await saveManifest(ctx.manifestRoot, m)
      await reconcile(m, names)
    })

  plugins.command('rm <id>')
    .option('--profile <p>').option('--all')
    .action(async (id: string, opts: any) => {
      const m = await requireManifest(ctx)
      const names = targets(m, opts)
      for (const t of names) { const pr = m.profiles.find(p => p.name === t)!; pr.plugins = pr.plugins.filter(x => x !== id) }
      if (!m.profiles.some(p => p.plugins.includes(id))) { const at = id.lastIndexOf('@'); const mkt = at > 0 ? id.slice(at + 1) : ''; if (mkt && !m.profiles.some(p => p.plugins.some(x => x.endsWith(`@${mkt}`)))) delete m.marketplaces[mkt] }
      await saveManifest(ctx.manifestRoot, m)
      await reconcile(m, names)
    })

  plugins.command('sync')
    .requiredOption('--from <p>').option('--to <csv>').option('--all')
    .action(async (opts: any) => {
      const m = await requireManifest(ctx)
      const src = m.profiles.find(p => p.name === opts.from)
      if (!src) throw new Error(`unknown profile: ${opts.from}`)
      const to = opts.all ? m.profiles.filter(p => p.name !== src.name && (p.agent ?? 'claude') === 'claude').map(p => p.name) : String(opts.to ?? '').split(',').filter(Boolean)
      if (!to.length) throw new Error('specify --to <p1,p2> or --all')
      for (const t of to) { const pr = m.profiles.find(p => p.name === t); if (!pr) throw new Error(`unknown profile: ${t}`); pr.plugins = [...src.plugins] }
      await saveManifest(ctx.manifestRoot, m)
      await reconcile(m, to)
    })
}
```

- [ ] **Step 5: Register in `context.ts`**

Import and call `registerPluginCommands(program, ctx)` after `registerSessionCommands(program, ctx)`.

- [ ] **Step 6: adopt builds `plugins` + `marketplaces` (`packages/core/src/adopt.ts`)**

In `buildManifest`: aggregate marketplaces across profiles and set each profile's `plugins` from its enabled set:

```ts
  const marketplaces: Manifest['marketplaces'] = {}
  for (const lp of live) for (const [name, def] of Object.entries(lp.marketplaces ?? {})) marketplaces[name] ??= def
```
In the `profiles.map(lp => ({ ... }))` return, add:
```ts
    plugins: Object.entries(lp.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k).sort(),
```
And return `{ version: 1, hub, profiles, mcpServers, marketplaces }`.

- [ ] **Step 7: Run tests + build + full suite**

Run: `npx vitest run packages/cli/test/plugins.test.ts && npm run build && npx vitest run`
Expected: plugins tests PASS; build clean; suite green.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/plugins.ts packages/cli/src/context.ts packages/core/src/adopt.ts packages/cli/test/plugins.test.ts
git commit -m "feat(cli): plugins list/add/rm/sync driving claude plugin CLI + adopt"
```

---

### Task 6: UI API — `/api/plugins`

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (new routes; reuse the reconcile helper pattern)
- Test: `packages/cli/test/ui-api-core.test.ts` (or a new `ui-api-plugins.test.ts`)

**Interfaces:**
- Produces: `GET /api/plugins` → `{ marketplaces: string[]; profiles: { name; has: string[] }[] }`; `POST /api/plugins` `{ id, source?, targets }`; `DELETE /api/plugins/:id` `{ targets }`; `POST /api/plugins/sync` `{ from, to }`. Mirrors the `/api/mcp` routes.

- [ ] **Step 1: Write the failing test**

Add (mirror the mcp api tests + inject a fake runner — the api server builds its own runner via ctx, so set `ctx.pluginRunner` in the test's context, same as the CLI test):

```ts
it('GET /api/plugins returns the plugin matrix; POST adds + reconciles', async () => {
  const calls: string[] = []
  const ctx = { ...baseCtx, pluginRunner: { marketplaceAdd: async () => {}, install: async (_d:string,id:string) => { calls.push(id) }, uninstall: async () => {} } }
  await callApi(ctx, 'POST', '/api/adopt')
  const res = await callApi(ctx, 'POST', '/api/plugins', { id: 'ponytail@ponytail', source: 'DietrichGebert/ponytail', targets: ['default'] })
  expect(res._status).toBe(200)
  expect(calls).toContain('ponytail@ponytail')
  const data = (await callApi(ctx, 'GET', '/api/plugins'))._json
  expect(data.profiles.find((p:any) => p.name === 'default').has).toContain('ponytail@ponytail')
})
```
(Match `callApi`/context construction and the `_status`/`_json` convention to the file's existing mcp tests; seed `known_marketplaces.json` in the test home like Task 5.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts -t plugins`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement the routes**

In `packages/cli/src/ui/api.ts`, add a reconcile helper mirroring the CLI's (use `ctx.pluginRunner ?? claudeRunner()`; you may export `claudeRunner` from `commands/plugins.ts` to avoid duplication, or inline a private copy), then the four routes mirroring the existing `/api/mcp` GET/POST/DELETE/sync handlers:
- `GET /api/plugins` → `{ marketplaces: Object.keys(m.marketplaces).sort(), profiles: m.profiles.filter(claude).map(p => ({ name: p.name, has: p.plugins })) }`.
- `POST /api/plugins` → validate `id`/`targets`; if marketplace unknown require `source` (400 else); push id to targets' `plugins`; save; reconcile targets.
- `DELETE /api/plugins/:id` → remove from targets; prune orphan marketplace; save; reconcile.
- `POST /api/plugins/sync` → mirror `/api/mcp/sync`.

Use `assertSafe(m)` before saving (as the mcp routes do).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/src/commands/plugins.ts packages/cli/test/ui-api-core.test.ts
git commit -m "feat(api): /api/plugins routes (matrix + add/rm/sync reconcile)"
```

---

### Task 7: UI frontend — Plugins matrix page

**Files:**
- Create: `packages/ui/src/pages/PluginsPage.tsx` (near-copy of `McpPage.tsx`)
- Modify: `packages/ui/src/lib/api.ts` (plugins methods), `packages/ui/src/App.tsx` (nav tab)
- Verify: `ProfileEditor.tsx` no longer references `sharedPlugins` (removed in Task 1).

- [ ] **Step 1: API client**

In `packages/ui/src/lib/api.ts`, add (mirroring the `mcp` methods):

```ts
  plugins: () => req('GET', '/api/plugins'),
  addPlugin: (b: object) => req('POST', '/api/plugins', b),
  rmPlugin: (id: string, targets: unknown) => req('DELETE', `/api/plugins/${encodeURIComponent(id)}`, { targets }),
  syncPlugins: (from: string, to: unknown) => req('POST', '/api/plugins/sync', { from, to }),
```

- [ ] **Step 2: Create `packages/ui/src/pages/PluginsPage.tsx`**

Copy `packages/ui/src/pages/McpPage.tsx` verbatim, then rename for plugins: `Mcp`→`Plugins`, `api.mcp`→`api.plugins`, `api.addMcp`→`api.addPlugin` (its dialog collects a plugin **id** and a **marketplace source** instead of command/args — fields `{ id, source }`, posting `{ id, source, targets: 'all' }` or per-profile), `api.rmMcp`→`api.rmPlugin`, `api.syncMcp`→`api.syncPlugins`. `data.servers`→`data.marketplaces`-derived plugin id rows: the matrix rows are the union of profile `has` ids; keep the same toggle grid (`Switch` per id×profile calling addPlugin/rmPlugin). Header "MCP servers"→"Plugins".

- [ ] **Step 3: Nav tab in `App.tsx`**

Import `PluginsPage`, add a lucide icon (e.g. `Puzzle`) to the import, add `['plugins', 'Plugins', Puzzle]` to `TABS` (after `mcp`), and `{tab === 'plugins' && <PluginsPage />}` to the render switch.

- [ ] **Step 4: Build + full suite**

Run: `npm run build && npx vitest run`
Expected: `vite build` type-checks clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/pages/PluginsPage.tsx packages/ui/src/lib/api.ts packages/ui/src/App.tsx
git commit -m "feat(ui): Plugins matrix page"
```

---

## Verification (end of plan)

- [ ] `npm run build` — clean.
- [ ] `npx vitest run` — full suite green.
- [ ] Sandbox check per `.claude/skills/verify/SKILL.md` with a FAKE runner path is covered by tests; for a real smoke test, `clp plugins list` on adopted profiles renders the matrix (no real installs needed). Real `claude plugin` execution is intentionally out of automated tests.

## Notes / limitations (from the spec)

- Reconcile drives the official `claude plugin` CLI; `claude` must be on PATH.
- Not folded into `clp apply` (stays offline/fast).
- v1 treats `enabledPlugins:true` as "present"; user scope only; Codex has no plugins.
- Legacy `plugins/` symlinks from the reverted feature are auto-restored to real dirs on first reconcile.
