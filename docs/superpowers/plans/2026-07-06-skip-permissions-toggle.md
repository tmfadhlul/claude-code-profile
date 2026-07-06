# Skip-Permissions Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-profile `skipPermissions` boolean that renders `claude --dangerously-skip-permissions` into that profile's launcher, toggleable in `clp ui`.

**Architecture:** New boolean on `ProfileDecl`; `rcblock` renders the flag before user args when set (launcher profiles only); UI exposes a checkbox (disabled without a launcher) + PATCH field. No new apply action — the managed rc block re-renders and existing drift detection applies it.

**Tech Stack:** Node 20+, TypeScript ESM, zod, vitest; React/Vite UI.

**Spec:** `docs/superpowers/specs/2026-07-06-skip-permissions-toggle-design.md`

## Global Constraints

- Run commands from repo root `~/Development/personal/ccprofiles`. Tests: `npx vitest run <file>`; full build `npm run build`; UI has no test runner (verify via build).
- Flag renders BEFORE user args: posix `claude --dangerously-skip-permissions "$@"`, pwsh `claude --dangerously-skip-permissions @args`. Only for profiles with a launcher.
- Follow existing code style (compact, 2-space; UI files omit semicolons).
- Commit after each task with the message given.

---

### Task 1: Manifest field + rcblock rendering

**Files:**
- Modify: `packages/core/src/manifest.ts` (ProfileSchema)
- Modify: `packages/core/src/rcblock.ts` (renderPosix ~line 33, renderPwsh ~line 44)
- Modify: `packages/core/src/adopt.ts`, `packages/cli/src/commands/manifest.ts`, `packages/cli/src/ui/api.ts` (ProfileDecl literals — add `skipPermissions: false`)
- Test: `packages/core/test/manifest.test.ts`, `packages/core/test/rcblock.test.ts`

**Interfaces:**
- Produces: `ProfileDecl.skipPermissions: boolean` (zod `.default(false)`). rcblock renders the flag when true + launcher present.

- [ ] **Step 1: Write failing tests** — append to `packages/core/test/manifest.test.ts`:

```ts
it('skipPermissions parses and defaults to false', () => {
  const withFlag = parseManifest(`
version: 1
hub: null
profiles:
  - name: z
    dir: "{home}/.claude-z"
    launcher: cl-z
    auth: env
    env: {}
    links: {}
    mcp: []
    skipPermissions: true
mcpServers: {}
`)
  expect(withFlag.profiles[0].skipPermissions).toBe(true)
  const noFlag = parseManifest(`
version: 1
hub: null
profiles:
  - name: z
    dir: "{home}/.claude-z"
    launcher: cl-z
    auth: env
    env: {}
    links: {}
    mcp: []
mcpServers: {}
`)
  expect(noFlag.profiles[0].skipPermissions).toBe(false)
})
```

And to `packages/core/test/rcblock.test.ts` (reuse its existing manifest/platform helpers; construct a profile with `launcher: 'cl-z'` and `skipPermissions`). Add:

```ts
it('renders --dangerously-skip-permissions before args when skipPermissions is set (posix)', () => {
  const m = { version: 1 as const, hub: null, mcpServers: {}, profiles: [
    { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env' as const, env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: true },
  ] }
  const block = renderRcBlock(m, detectPlatform({ home: '/home/u', shell: '/bin/zsh' }))
  expect(block).toContain('claude --dangerously-skip-permissions "$@"')
})
it('omits the flag when skipPermissions is false (posix)', () => {
  const m = { version: 1 as const, hub: null, mcpServers: {}, profiles: [
    { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env' as const, env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: false },
  ] }
  const block = renderRcBlock(m, detectPlatform({ home: '/home/u', shell: '/bin/zsh' }))
  expect(block).toContain('claude "$@"')
  expect(block).not.toContain('--dangerously-skip-permissions')
})
it('renders the flag for pwsh (win32)', () => {
  const m = { version: 1 as const, hub: null, mcpServers: {}, profiles: [
    { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env' as const, env: {}, links: {}, mcp: [], settingsEnv: {}, skipPermissions: true },
  ] }
  const block = renderRcBlock(m, detectPlatform({ osKind: 'win32', home: 'C:/Users/u' }))
  expect(block).toContain('claude --dangerously-skip-permissions @args')
})
```

(Adjust imports so `renderRcBlock` and `detectPlatform` are imported; match whatever the file already imports. Existing rcblock tests already build similar profile literals — mirror their exact shape, adding `skipPermissions`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/manifest.test.ts packages/core/test/rcblock.test.ts`
Expected: FAIL — `skipPermissions` stripped by schema / flag absent from render.

- [ ] **Step 3: Implement**

`packages/core/src/manifest.ts` — add to `ProfileSchema` after `settingsEnv`:

```ts
  skipPermissions: z.boolean().default(false),
```

`packages/core/src/rcblock.ts` — in `renderPosix`, replace the claude line:

```ts
  const flag = pr.skipPermissions ? ' --dangerously-skip-permissions' : ''
  lines.push(`  CLAUDE_CONFIG_DIR="${profileDirExpr(pr, p)}" claude${flag} "$@"`, '}')
```

In `renderPwsh`, replace the claude line:

```ts
  const flag = pr.skipPermissions ? ' --dangerously-skip-permissions' : ''
  lines.push(`  $env:CLAUDE_CONFIG_DIR = "${profileDirExpr(pr, p)}"`, `  claude${flag} @args`, '}')
```

Add `skipPermissions: false,` to the three ProfileDecl literals:
- `packages/core/src/adopt.ts` (profile literal, after `settingsEnv: lp.settingsEnv,`)
- `packages/cli/src/commands/manifest.ts` create literal (after `settingsEnv: {},`)
- `packages/cli/src/ui/api.ts` POST /api/profiles literal (after `settingsEnv: {},`)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test packages/cli/test && npx tsc -b packages/core packages/cli`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/rcblock.ts packages/core/src/adopt.ts packages/cli/src/commands/manifest.ts packages/cli/src/ui/api.ts packages/core/test/manifest.test.ts packages/core/test/rcblock.test.ts
git commit -m "feat(core): per-profile skipPermissions renders --dangerously-skip-permissions in launcher"
```

---

### Task 2: UI API — GET row + PATCH field

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (GET /api/profiles row; PATCH /api/profiles/:name)
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Consumes: Task 1's `skipPermissions` field.
- Produces: profile rows include `skipPermissions: boolean`; PATCH accepts it (400 non-boolean). Task 3 consumes the row field.

- [ ] **Step 1: Write failing test** — append to `packages/cli/test/ui-api-core.test.ts`:

```ts
it('PATCH skipPermissions renders the flag into the launcher and GET returns it', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  await callApi(ctx, 'POST', '/api/profiles', { name: 'work' })   // gets launcher cl-work
  const res = await callApi(ctx, 'PATCH', '/api/profiles/work', { skipPermissions: true })
  expect(res._status).toBe(200)
  const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'work')
  expect(row.skipPermissions).toBe(true)
  const rc = await readFile(ctx.platform.rcFile, 'utf8')
  expect(rc).toContain('claude --dangerously-skip-permissions "$@"')
})
it('PATCH skipPermissions rejects a non-boolean', async () => {
  await callApi(ctx, 'POST', '/api/adopt')
  const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { skipPermissions: 'yes' })
  expect(res._status).toBe(400)
})
```

(Ensure `readFile` from `node:fs/promises` is imported in the file — it is in the current test file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts`
Expected: FAIL — `skipPermissions` ignored (row undefined / flag absent).

- [ ] **Step 3: Implement** — in `packages/cli/src/ui/api.ts`:

GET /api/profiles row — add after `settingsEnv`:

```ts
        skipPermissions: decl?.skipPermissions ?? false,
```

PATCH /api/profiles/:name — extend the body type and handling. Add `skipPermissions?: boolean` to the `readJson<…>` generic, and before `assertSafe(m)`:

```ts
    if (body.skipPermissions !== undefined) {
      if (typeof body.skipPermissions !== 'boolean') throw new HttpError(400, 'skipPermissions must be a boolean')
      pr.skipPermissions = body.skipPermissions
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts && npx tsc -b packages/core packages/cli`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/test/ui-api-core.test.ts
git commit -m "feat(ui-api): expose and accept skipPermissions on profiles"
```

---

### Task 3: UI editor checkbox + table badge

**Files:**
- Modify: `packages/ui/src/components/ProfileEditor.tsx`
- Modify: `packages/ui/src/pages/ProfilesPage.tsx`

**Interfaces:**
- Consumes: Task 2 row field; `api.patchProfile` accepts `skipPermissions`.
- Produces: `ProfileRow` gains `skipPermissions: boolean`.

- [ ] **Step 1: Editor** — in `packages/ui/src/components/ProfileEditor.tsx`:

Add `skipPermissions: boolean` to the `ProfileRow` type (after `liveSettingsEnv`).

Add state near the other `useState`s:

```tsx
  const [skipPermissions, setSkipPermissions] = useState(profile.skipPermissions)
```

Include it in the `api.patchProfile` call body (add to the existing object):

```tsx
        skipPermissions,
```

Add the checkbox UI right after the "Launcher function" block (so it reads next to the launcher it modifies):

```tsx
          <div className="space-y-1.5">
            <label className={cn('flex items-center gap-2 text-sm', !launcher.trim() && 'opacity-50')}>
              <input type="checkbox" checked={skipPermissions} disabled={!launcher.trim()}
                onChange={e => setSkipPermissions(e.target.checked)} />
              Skip all permission prompts (<span className="font-mono text-xs">--dangerously-skip-permissions</span>)
            </label>
            {!launcher.trim()
              ? <p className="text-xs text-muted-foreground">No launcher — plain <span className="font-mono">claude</span> can't take this flag.</p>
              : skipPermissions && <p className="text-xs text-red-600 dark:text-red-400">⚠ Bypasses every confirmation — use only for profiles you fully trust.</p>}
          </div>
```

Import `cn` if not already imported: `import { cn } from '@/lib/utils'` (check existing imports first; add only if missing).

- [ ] **Step 2: Table badge** — in `packages/ui/src/pages/ProfilesPage.tsx`, the launcher cell currently renders `{r.launcher ?? '—'}`. Change it to append a badge when the flag is on:

```tsx
              <TableCell className="font-mono text-xs">
                {r.launcher ?? '—'}
                {r.skipPermissions && <span className="ml-1.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 px-1 py-0.5 text-[10px] not-italic">skip-perms</span>}
              </TableCell>
```

(Locate the existing launcher `<TableCell>` — it renders `r.launcher`; replace that single cell. Confirm the exact current markup before editing.)

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: exits 0 (SecretsPage/other consumers of ProfileRow still compile — the added field is compatible).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/ProfileEditor.tsx packages/ui/src/pages/ProfilesPage.tsx
git commit -m "feat(ui): skip-permissions checkbox (launcher-gated) + table badge"
```

---

### Task 4: Full suite + sandboxed e2e

**Files:** none new (fixes only, if anything fails)

- [ ] **Step 1: Full build + tests**

Run: `npm run build && npm test`
Expected: build exits 0; all suites pass.

- [ ] **Step 2: Sandboxed e2e** — follow `.claude/skills/verify/SKILL.md` (sandboxed home). Verify:
  1. adopt → create profile `work` (has launcher `cl-work`).
  2. PATCH `skipPermissions:true` → the managed block in the sandbox rc file contains `cl-work() { … claude --dangerously-skip-permissions "$@" }`.
  3. PATCH `skipPermissions:false` → the flag is gone from the block.
  4. GET /api/profiles → `work` row shows `skipPermissions` reflecting the current state.

- [ ] **Step 3: Fix anything that failed, re-run covering tests, commit** as `test: e2e verification fixes for skip-permissions toggle` (skip if nothing failed).
