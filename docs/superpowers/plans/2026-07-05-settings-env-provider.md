# settingsEnv Provider Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Profiles get a manifest-managed `settingsEnv` map that clp applies into `<profile-dir>/settings.json` `env` (base URL, auth token via `secret://`, model mappings), with adopt/migrate/doctor/UI support.

**Architecture:** New `settingsEnv` field on `ProfileDecl`; discovery reads live settings.json env; a new `set-settings-env` apply action owns the whole `env` object when `settingsEnv` is non-empty (mirrors `set-mcp-servers`); `secret://` refs resolved from the secrets store *before* planning via `resolveSettingsEnv` + a shared CLI helper `planActions(ctx, m)` used by every plan/apply call site.

**Tech Stack:** Node 20+, TypeScript ESM, zod, vitest; React/Vite UI.

**Spec:** `docs/superpowers/specs/2026-07-05-settings-env-provider-design.md`

## Global Constraints

- Run all commands from repo root `~/Development/personal/ccprofiles`. Tests: `npx vitest run <file>`; full build `npm run build`; UI has no test runner (verify via build).
- `settingsEnv` semantics: non-empty → clp owns the entire `env` object in that profile's settings.json; empty → the file is never touched. All other settings.json keys must be preserved on write.
- Secret resolution error format (exact): `profile "<name>": secret not found: <ref> (for <KEY>)`.
- Migrated settings secrets are named `<var-kebab>-<profile>` (e.g. `anthropic-auth-token-z`).
- `settingsEnv` keys validate against `SAFE_ENV_KEY`; `secret://` refs against `SAFE_NAME`; values otherwise freeform (JSON, not shell).
- Follow existing code style (compact, 2-space; UI files have no semicolons).
- Commit after each task with the message given.

---

### Task 1: Manifest schema + validation + construction-site updates

**Files:**
- Modify: `packages/core/src/manifest.ts` (ProfileSchema ~line 19-27, assertSafeManifest ~line 50-64)
- Modify: `packages/core/src/adopt.ts:32-40` (profile literal)
- Modify: `packages/cli/src/commands/manifest.ts:42-50` (create-profile literal)
- Modify: `packages/cli/src/ui/api.ts` (POST /api/profiles profile literal)
- Test: `packages/core/test/manifest.test.ts`

**Interfaces:**
- Produces: `ProfileDecl.settingsEnv: Record<string, string>` (zod `.default({})`, so required in the inferred type — every object-literal construction site must include it). Validation errors are `ManifestError`s mentioning the profile name.

- [ ] **Step 1: Write the failing tests** — append to `packages/core/test/manifest.test.ts` (match the file's existing import style; it already imports `parseManifest` and `serializeManifest` or similar — extend as needed):

```ts
describe('settingsEnv', () => {
  const base = (settingsEnv: string) => `
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
${settingsEnv}
mcpServers: {}
`
  it('parses settingsEnv and defaults to {}', () => {
    const m = parseManifest(base(`    settingsEnv:\n      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic"\n      API_TIMEOUT_MS: "3000000"`))
    expect(m.profiles[0].settingsEnv.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    const m2 = parseManifest(base(''))
    expect(m2.profiles[0].settingsEnv).toEqual({})
  })
  it('rejects unsafe settingsEnv key', () => {
    expect(() => parseManifest(base(`    settingsEnv:\n      "BAD KEY": "x"`))).toThrow(/unsafe settings env var name/)
  })
  it('rejects empty or unsafe secret ref in settingsEnv', () => {
    expect(() => parseManifest(base(`    settingsEnv:\n      ANTHROPIC_AUTH_TOKEN: "secret://"`))).toThrow(/unsafe secret reference/)
  })
  it('allows freeform values (urls, dollars) in settingsEnv', () => {
    const m = parseManifest(base(`    settingsEnv:\n      FOO: "has $dollar and \\"quotes\\" and ; semicolons"`))
    expect(m.profiles[0].settingsEnv.FOO).toContain('$dollar')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/manifest.test.ts`
Expected: FAIL — `settingsEnv` is stripped by the schema (`undefined`), and the two `rejects` tests fail because no error is thrown.

- [ ] **Step 3: Implement** — in `packages/core/src/manifest.ts`:

Add to `ProfileSchema` after `mcp`:

```ts
  settingsEnv: z.record(z.string()).default({}),
```

In `assertSafeManifest`, after the existing `p.env` loop, add:

```ts
    for (const [k, v] of Object.entries(p.settingsEnv)) {
      if (!SAFE_ENV_KEY.test(k)) throw new ManifestError(`unsafe settings env var name in profile "${p.name}": ${JSON.stringify(k)}`)
      if (v.startsWith(SECRET_PREFIX)) {
        const ref = v.slice(SECRET_PREFIX.length)
        if (!SAFE_NAME.test(ref)) throw new ManifestError(`unsafe secret reference in profile "${p.name}": ${JSON.stringify(v)}`)
      }
    }
```

(Do NOT apply `SHELL_META` to `settingsEnv` values — they go into JSON, not shell.)

Fix the three ProfileDecl construction sites (TypeScript now requires the field):
- `packages/core/src/adopt.ts` profile literal: add `settingsEnv: {},` after `mcp: ...` (Task 2 replaces this with the discovered value).
- `packages/cli/src/commands/manifest.ts` create-profile literal (~line 49): add `settingsEnv: {},` after `mcp: ...`.
- `packages/cli/src/ui/api.ts` POST /api/profiles literal (~line 75-79): add `settingsEnv: {},` after `mcp: ...`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/manifest.test.ts && npx tsc -b packages/core packages/cli`
Expected: tests PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/adopt.ts packages/cli/src/commands/manifest.ts packages/cli/src/ui/api.ts packages/core/test/manifest.test.ts
git commit -m "feat(core): settingsEnv field on profiles — schema + validation"
```

---

### Task 2: Discovery reads settings.json env; adopt imports it

**Files:**
- Modify: `packages/core/src/discovery.ts`
- Modify: `packages/core/src/adopt.ts`
- Test: `packages/core/test/discovery.test.ts`, `packages/core/test/adopt.test.ts`

**Interfaces:**
- Produces: `LiveProfile.settingsEnv: Record<string, string>` (missing/invalid settings.json or non-object `env` → `{}`; non-string values skipped). `buildManifest` sets each profile's `settingsEnv` to the live value.

- [ ] **Step 1: Write the failing tests** — append to `packages/core/test/discovery.test.ts` (reuse its existing temp-home setup helpers/style):

```ts
  it('reads settingsEnv from settings.json, skipping non-strings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-disc-senv-'))
    await mkdir(join(home, '.claude-z'), { recursive: true })
    await writeFile(join(home, '.claude-z', '.claude.json'), '{}')
    await writeFile(join(home, '.claude-z', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', NUM: 42 },
      model: 'opus',
    }))
    const live = await discoverProfiles(home)
    const z = live.find(l => l.dirName === '.claude-z')!
    expect(z.settingsEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
  })
  it('settingsEnv is {} when settings.json is absent or invalid', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-disc-senv2-'))
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude.json'), '{}')
    const live = await discoverProfiles(home)
    expect(live[0].settingsEnv).toEqual({})
  })
```

And to `packages/core/test/adopt.test.ts`:

```ts
  it('imports live settingsEnv into the manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-adopt-senv-'))
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude.json'), '{}')
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }))
    const m = buildManifest(await discoverProfiles(home), detectPlatform({ home, shell: '/bin/zsh' }))
    expect(m.profiles[0].settingsEnv.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
  })
```

(Adjust imports at the top of each test file to include anything not yet imported: `mkdtemp`, `mkdir`, `writeFile` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `discoverProfiles`, `buildManifest`, `detectPlatform` from the package source as the file already does.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/discovery.test.ts packages/core/test/adopt.test.ts`
Expected: FAIL — `settingsEnv` undefined on LiveProfile.

- [ ] **Step 3: Implement**

`packages/core/src/discovery.ts` — add to the interface:

```ts
  settingsEnv: Record<string, string>
```

In `discoverProfiles`, before `out.push(...)`:

```ts
    const settingsEnv: Record<string, string> = {}
    try {
      const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      if (s && typeof s.env === 'object' && s.env !== null)
        for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') settingsEnv[k] = v
    } catch { /* no settings.json */ }
```

and add `settingsEnv,` to the pushed object.

`packages/core/src/adopt.ts` — in the profile literal, replace `settingsEnv: {},` (from Task 1) with:

```ts
      settingsEnv: lp.settingsEnv,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/discovery.test.ts packages/core/test/adopt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/discovery.ts packages/core/src/adopt.ts packages/core/test/discovery.test.ts packages/core/test/adopt.test.ts
git commit -m "feat(core): discover and adopt settings.json env as settingsEnv"
```

---

### Task 3: resolveSettingsEnv + apply action `set-settings-env`

**Files:**
- Modify: `packages/core/src/apply.ts`
- Test: `packages/core/test/apply.test.ts`

**Interfaces:**
- Consumes: `ProfileDecl.settingsEnv` (Task 1), `LiveProfile.settingsEnv` (Task 2).
- Produces:
  - `resolveSettingsEnv(m: Manifest, getSecret: (name: string) => Promise<string | null>): Promise<Record<string, Record<string, string>>>` — profile name → fully resolved env; throws `Error('profile "<name>": secret not found: <ref> (for <KEY>)')` on a missing secret.
  - `planApply(m, live, p, resolvedSettingsEnv?)` — optional 4th arg; when omitted and a profile's `settingsEnv` contains `secret://` refs, throws `Error('profile "<name>": settingsEnv has secret refs — pass resolved settings env to planApply')`.
  - New `ApplyAction` variant `{ kind: 'set-settings-env'; settingsPath: string; env: Record<string, string> }`; executeApply writes it preserving all other settings.json keys; describe → `set settings env (<n>) in <path>`.

- [ ] **Step 1: Write the failing tests** — append to `packages/core/test/apply.test.ts` (reuse its setup style; it builds Manifest objects and LiveProfile arrays inline):

```ts
describe('settingsEnv apply', () => {
  const platformFor = (home: string) => detectPlatform({ home, shell: '/bin/zsh' })
  const manifestWith = (settingsEnv: Record<string, string>): Manifest => ({
    version: 1, hub: null, mcpServers: {},
    profiles: [{ name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env', env: {}, links: {}, mcp: [], settingsEnv }],
  })

  it('resolveSettingsEnv resolves secret refs and passes plain values', async () => {
    const m = manifestWith({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'secret://z-token' })
    const r = await resolveSettingsEnv(m, async n => (n === 'z-token' ? 'tok-123' : null))
    expect(r.z).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok-123' })
  })
  it('resolveSettingsEnv throws on missing secret with exact message', async () => {
    const m = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://nope' })
    await expect(resolveSettingsEnv(m, async () => null))
      .rejects.toThrow('profile "z": secret not found: nope (for ANTHROPIC_AUTH_TOKEN)')
  })
  it('plans and executes set-settings-env, preserving other settings.json keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-apply-senv-'))
    const p = platformFor(home)
    const dir = join(home, '.claude-z')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.claude.json'), '{}')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ model: 'opus', env: { OLD: '1' } }))
    const m = manifestWith({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
    const live = await discoverProfiles(home)
    const resolved = await resolveSettingsEnv(m, async () => null)
    const actions = planApply(m, live, p, resolved)
    expect(actions.some(a => a.kind === 'set-settings-env')).toBe(true)
    await executeApply(actions, { backupRoot: join(home, 'bk'), stamp: 's1' })
    const s = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(s.model).toBe('opus')
    expect(s.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
    // idempotent: re-plan sees no drift
    const again = planApply(m, await discoverProfiles(home), p, resolved)
    expect(again.filter(a => a.kind === 'set-settings-env')).toEqual([])
  })
  it('empty settingsEnv never touches settings.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-apply-senv2-'))
    const p = platformFor(home)
    const dir = join(home, '.claude-z')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.claude.json'), '{}')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ env: { HAND: 'edited' } }))
    const m = manifestWith({})
    const actions = planApply(m, await discoverProfiles(home), p)
    expect(actions.filter(a => a.kind === 'set-settings-env')).toEqual([])
  })
  it('planApply without resolved map throws if secret refs present', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-apply-senv3-'))
    const m = manifestWith({ ANTHROPIC_AUTH_TOKEN: 'secret://z-token' })
    expect(() => planApply(m, [], platformFor(home))).toThrow(/pass resolved settings env/)
  })
})
```

(Extend the test file's imports as needed: `resolveSettingsEnv`, `discoverProfiles`, `detectPlatform`, `type Manifest`, fs/promises helpers.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/apply.test.ts`
Expected: FAIL — `resolveSettingsEnv` not exported.

- [ ] **Step 3: Implement** — in `packages/core/src/apply.ts`:

Add to the `ApplyAction` union:

```ts
  | { kind: 'set-settings-env'; settingsPath: string; env: Record<string, string> }
```

Add the resolver (top-level export, after the imports):

```ts
const SECRET_PREFIX = 'secret://'

/** Resolve secret:// refs in every profile's settingsEnv. Throws on a missing secret. */
export async function resolveSettingsEnv(
  m: Manifest,
  getSecret: (name: string) => Promise<string | null>,
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  for (const pr of m.profiles) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(pr.settingsEnv ?? {})) {
      if (v.startsWith(SECRET_PREFIX)) {
        const ref = v.slice(SECRET_PREFIX.length)
        const val = await getSecret(ref)
        if (val === null) throw new Error(`profile "${pr.name}": secret not found: ${ref} (for ${k})`)
        env[k] = val
      } else env[k] = v
    }
    out[pr.name] = env
  }
  return out
}
```

Change `planApply`'s signature and add planning inside the per-profile loop (after the links block, before the rc section):

```ts
export function planApply(m: Manifest, live: LiveProfile[], p: Platform, resolvedSettingsEnv?: Record<string, Record<string, string>>): ApplyAction[] {
```

```ts
    const senv = pr.settingsEnv ?? {} // literals in older tests may omit the field
    if (Object.keys(senv).length > 0) {
      let desired = resolvedSettingsEnv?.[pr.name]
      if (!desired) {
        if (Object.values(senv).some(v => v.startsWith(SECRET_PREFIX)))
          throw new Error(`profile "${pr.name}": settingsEnv has secret refs — pass resolved settings env to planApply`)
        desired = senv
      }
      const currentEnv = lp?.settingsEnv ?? null
      if (!currentEnv || JSON.stringify(sortKeys(currentEnv)) !== JSON.stringify(sortKeys(desired))) {
        actions.push({ kind: 'set-settings-env', settingsPath: join(dir, 'settings.json'), env: desired })
      }
    }
```

In `executeApply`, extend the `touched` computation:

```ts
  const touched = actions.flatMap(a =>
    a.kind === 'set-mcp-servers' ? [a.configPath]
    : a.kind === 'rc-block' ? [a.rcFile]
    : a.kind === 'set-settings-env' ? [a.settingsPath]
    : [])
```

Add the execution branch (after the `set-mcp-servers` branch):

```ts
    } else if (a.kind === 'set-settings-env') {
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(await readFile(a.settingsPath, 'utf8')) } catch { /* new file */ }
      cfg.env = a.env
      await mkdir(dirname(a.settingsPath), { recursive: true })
      await atomicWrite(a.settingsPath, JSON.stringify(cfg, null, 2))
```

Add to `describe`:

```ts
    case 'set-settings-env': return `set settings env (${Object.keys(a.env).length}) in ${a.settingsPath}`
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/apply.ts packages/core/test/apply.test.ts
git commit -m "feat(core): set-settings-env apply action with secret resolution"
```

---

### Task 4: CLI `planActions` helper wired into every plan site + UI API GET/PATCH `settingsEnv`

**Files:**
- Create: `packages/cli/src/plan.ts`
- Modify: `packages/cli/src/commands/manifest.ts` (status :12, apply :22, create :52), `packages/cli/src/commands/mcp.ts` (applyNow :10), `packages/cli/src/commands/bundle.ts` (:41), `packages/cli/src/commands/sync.ts` (:76), `packages/cli/src/ui/api.ts` (applyAndReport, status route, sync route, GET/PATCH profiles)
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Consumes: `resolveSettingsEnv`, `planApply(..., resolved)` from Task 3; `secretsStore(ctx)` from `packages/cli/src/commands/secrets.ts`.
- Produces: `planActions(ctx: CliContext, m: Manifest): Promise<ApplyAction[]>` in `packages/cli/src/plan.ts` — the ONLY way CLI/UI code plans actions from now on. UI API: profile rows gain `settingsEnv: Record<string,string>`; PATCH accepts `settingsEnv` (400 on non-string values). Task 6 consumes the row field.

- [ ] **Step 1: Write the failing tests** — append to `packages/cli/test/ui-api-core.test.ts`:

```ts
  it('PATCH settingsEnv with a secret ref applies resolved value into settings.json, preserving other keys', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
    await callApi(ctx, 'PUT', '/api/secrets/z-token', { value: 'tok-abc' })
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', {
      settingsEnv: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'secret://z-token' },
    })
    expect(res._status).toBe(200)
    const s = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(s.model).toBe('opus')
    expect(s.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok-abc' })
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://z-token') // manifest keeps the ref, not the value
  })
  it('PATCH settingsEnv with missing secret 400s and does not write settings.json', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { settingsEnv: { T: 'secret://ghost' } })
    expect(res._status).toBe(400)
    expect(res._json.error).toMatch(/secret not found: ghost/)
  })
  it('PATCH settingsEnv rejects non-string values', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { settingsEnv: { N: 42 } })
    expect(res._status).toBe(400)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts`
Expected: FAIL — `settingsEnv` ignored by PATCH (first test's `s.env` undefined).

- [ ] **Step 3: Implement**

Create `packages/cli/src/plan.ts`:

```ts
import { discoverProfiles, planApply, resolveSettingsEnv, type ApplyAction, type Manifest, type SecretsStore } from 'ccprofiles-core'
import { secretsStore } from './commands/secrets.js'
import type { CliContext } from './context.js'

/** Plan apply actions with settingsEnv secret refs resolved from the secrets store (lazily opened). */
export async function planActions(ctx: CliContext, m: Manifest): Promise<ApplyAction[]> {
  let store: SecretsStore | null = null
  const resolved = await resolveSettingsEnv(m, async name => {
    store ??= await secretsStore(ctx)
    return store.get(name)
  })
  return planApply(m, await discoverProfiles(ctx.home), ctx.platform, resolved)
}
```

Replace every `planApply(m, await discoverProfiles(ctx.home), ctx.platform)` call with `await planActions(ctx, m)`:

- `packages/cli/src/commands/manifest.ts` lines 12, 22, 52 → `const actions = await planActions(ctx, m)`. Import: `import { planActions } from '../plan.js'`; drop `planApply` (and `discoverProfiles` if now unused — it is still used by `snapshot` at :30, keep it).
- `packages/cli/src/commands/mcp.ts` `applyNow` line 10 → same replacement; adjust imports.
- `packages/cli/src/commands/bundle.ts` line 41 → same.
- `packages/cli/src/commands/sync.ts` line 76 → same.
- `packages/cli/src/ui/api.ts`: `applyAndReport` (line ~24), the status route, and the sync route each currently call `planApply(m, await discoverProfiles(ctx.home), ctx.platform)` — replace with `await planActions(ctx, m)`; add `import { planActions } from '../plan.js'` and remove now-unused `planApply` import if nothing else uses it (`discoverProfiles` is still used by GET /api/profiles and doctor — keep).

In `packages/cli/src/ui/api.ts`:

GET /api/profiles row: add after `mcpNames`:

```ts
        settingsEnv: decl?.settingsEnv ?? {},
```

PATCH /api/profiles/:name: extend the body type and handling (mirroring the existing env/links string checks added previously):

```ts
    const body = await readJson<{ env?: Record<string, string>; links?: Record<string, string>; launcher?: string | null; settingsEnv?: Record<string, string> }>(req)
```

```ts
    if (body.settingsEnv) {
      for (const v of Object.values(body.settingsEnv)) if (typeof v !== 'string') throw new HttpError(400, 'settingsEnv values must be strings')
      pr.settingsEnv = body.settingsEnv
    }
```

The route already runs `assertSafe(m)` before `saveManifest` and then `applyAndReport(m)`; `applyAndReport` now resolves secrets, so a missing secret throws — wrap is unnecessary (the plain Error propagates as 500). To meet the 400 requirement, map it in the PATCH route: after `assertSafe(m)` and before `saveManifest`, pre-resolve to validate:

```ts
    try { await planActionsPreflight(ctx, m) } catch (e) { throw new HttpError(400, (e as Error).message) }
```

Implementation of the preflight — add alongside `planActions` in `packages/cli/src/plan.ts`:

```ts
/** Resolve settingsEnv secrets without planning — cheap validation that refs exist. */
export async function planActionsPreflight(ctx: CliContext, m: Manifest): Promise<void> {
  let store: SecretsStore | null = null
  await resolveSettingsEnv(m, async name => {
    store ??= await secretsStore(ctx)
    return store.get(name)
  })
}
```

Import both in api.ts. Order in the PATCH route: mutate `pr` → `assertSafe(m)` → preflight (400 on missing secret, BEFORE saving) → `saveManifest` → `applyAndReport`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts && npx vitest run packages/cli/test && npx tsc -b packages/core packages/cli`
Expected: all cli tests PASS (existing suites must not regress), build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/plan.ts packages/cli/src/commands/manifest.ts packages/cli/src/commands/mcp.ts packages/cli/src/commands/bundle.ts packages/cli/src/commands/sync.ts packages/cli/src/ui/api.ts packages/cli/test/ui-api-core.test.ts
git commit -m "feat(cli): planActions resolves settingsEnv secrets; ui-api exposes settingsEnv"
```

---

### Task 5: secrets migrate for settings.json tokens + doctor checks

**Files:**
- Modify: `packages/cli/src/commands/secrets.ts` (export KEY_VARS, add migrateSettingsSecrets, wire into `sec.command('migrate')` at :79)
- Modify: `packages/cli/src/commands/profiles.ts` (doctor, :35-61)
- Modify: `packages/cli/src/ui/api.ts` (doctor route, migrate route)
- Test: `packages/cli/test/ui-api-secrets.test.ts` (or `packages/cli/test/secrets.test.ts` if migrate tests live there — check both, put UI-route tests in ui-api-secrets)

**Interfaces:**
- Consumes: `loadManifest`/`saveManifest` (core), `secretsStore` (existing), `LiveProfile.settingsEnv` (Task 2).
- Produces: `migrateSettingsSecrets(ctx: CliContext, opts?: { dryRun?: boolean }): Promise<string[]>` (returns stored secret names, e.g. `['anthropic-auth-token-z']`); exported `KEY_VARS`. Doctor problem string (exact shape): `plaintext token <VAR> in <dir>/settings.json — adopt profile then run: secrets migrate`.

- [ ] **Step 1: Write the failing tests** — append to `packages/cli/test/ui-api-secrets.test.ts` (reuse its beforeEach ctx setup; it sets `CCPROFILES_PASSPHRASE`):

```ts
  it('migrate moves settings.json token from manifest to keychain ref', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-1', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    }))
    await callApi(ctx, 'POST', '/api/adopt') // imports plaintext settingsEnv into manifest
    const res = await callApi(ctx, 'POST', '/api/secrets/migrate')
    expect(res._json.migrated).toContain('anthropic-auth-token-default')
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://anthropic-auth-token-default')
    expect((await callApi(ctx, 'GET', '/api/secrets/anthropic-auth-token-default'))._json.value).toBe('plain-tok-1')
    // live settings.json still carries the plaintext value (Claude Code must read it)
    const s = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe('plain-tok-1')
  })
  it('doctor flags unmanaged plaintext token in settings.json', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-2' } }))
    const res = await callApi(ctx, 'GET', '/api/doctor')
    expect(res._json.problems.join('\n')).toMatch(/plaintext token ANTHROPIC_AUTH_TOKEN/)
  })
  it('doctor is quiet once the token is manifest-managed', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-3' } }))
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/secrets/migrate')
    const res = await callApi(ctx, 'GET', '/api/doctor')
    expect(res._json.problems.join('\n')).not.toMatch(/plaintext token/)
  })
```

(Add `readFile`/`writeFile`/`join` imports if missing in that file; if its beforeEach doesn't create `home/.claude` + `.claude.json`, mirror the ui-api-core.test.ts setup.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/cli/test/ui-api-secrets.test.ts`
Expected: FAIL — `migrated` lacks `anthropic-auth-token-default`; doctor doesn't flag.

- [ ] **Step 3: Implement**

`packages/cli/src/commands/secrets.ts`:
- change `const KEY_VARS = ...` to `export const KEY_VARS = ...`.
- add imports: `loadManifest, saveManifest` to the `ccprofiles-core` import; `join` from `node:path`.
- add after `migrateRcSecrets`:

```ts
/** Move plaintext token values in manifest settingsEnv into the secrets store as secret:// refs. */
export async function migrateSettingsSecrets(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  if (!existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) return []
  const m = await loadManifest(ctx.manifestRoot)
  const store = await secretsStore(ctx)
  const migrated: string[] = []
  for (const pr of m.profiles) {
    for (const varName of KEY_VARS) {
      const v = pr.settingsEnv[varName]
      if (!v || v.startsWith('secret://')) continue
      const secretName = `${varName.toLowerCase().replaceAll('_', '-')}-${pr.name}`
      if (!opts.dryRun) await store.set(secretName, v)
      pr.settingsEnv[varName] = `secret://${secretName}`
      migrated.push(secretName)
    }
  }
  if (migrated.length && !opts.dryRun) await saveManifest(ctx.manifestRoot, m)
  return migrated
}
```

- update the `migrate` command action (:79):

```ts
  sec.command('migrate').option('--dry-run').action(async (opts: { dryRun?: boolean }) => {
    const migrated = [...await migrateRcSecrets(ctx, opts), ...await migrateSettingsSecrets(ctx, opts)]
    if (migrated.length === 0) { console.log('no plaintext keys found'); return }
    for (const n of migrated) console.log(`${opts.dryRun ? '[dry-run] ' : ''}migrated ${n}`)
  })
```

`packages/cli/src/ui/api.ts` — migrate route becomes:

```ts
  add('POST', /^\/api\/secrets\/migrate$/, async (_m, _req, res) => {
    sendJson(res, 200, { migrated: [...await migrateRcSecrets(ctx), ...await migrateSettingsSecrets(ctx)] })
  })
```

(extend the `../commands/secrets.js` import with `migrateSettingsSecrets`.)

Doctor — UI route in `packages/cli/src/ui/api.ts`: load the manifest up front (nullable) and add the token scan inside the live-profile loop. Full route body:

```ts
  add('GET', /^\/api\/doctor$/, async (_m, _req, res) => {
    const problems: string[] = []
    const live = await discoverProfiles(ctx.home)
    let man: Manifest | null = null
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) man = await loadManifest(ctx.manifestRoot)
    for (const lp of live) {
      for (const nm of readdirSync(lp.dir)) {
        const f = join(lp.dir, nm)
        try { if (lstatSync(f).isSymbolicLink() && !existsSync(f)) problems.push(`broken symlink: ${f} -> ${readlinkSync(f)}`) } catch { /* skip */ }
      }
      const decl = man?.profiles.find(p => p.name === profileName(lp.dirName)) ?? null
      for (const varName of KEY_VARS)
        if (lp.settingsEnv[varName] && !decl?.settingsEnv[varName])
          problems.push(`plaintext token ${varName} in ${join(lp.dir, 'settings.json')} — adopt profile then run: secrets migrate`)
    }
    if (existsSync(ctx.platform.rcFile)) {
      const rc = readFileSync(ctx.platform.rcFile, 'utf8')
      const outside = rc.split('# >>> ccprofiles managed >>>')[0] + (rc.split('# <<< ccprofiles managed <<<')[1] ?? '')
      if (/sk-ant-/.test(outside)) problems.push(`plaintext Anthropic key in ${ctx.platform.rcFile} — run secrets migrate`)
    }
    if (man) for (const pr of man.profiles) {
      const dir = pr.dir.replace('{home}', ctx.home)
      if (!existsSync(dir)) problems.push(`manifest profile "${pr.name}" missing on disk: ${dir} — run apply`)
    }
    sendJson(res, 200, { problems })
  })
```

(import `KEY_VARS` from `../commands/secrets.js`.)

CLI doctor in `packages/cli/src/commands/profiles.ts` — inside the live loop (after the broken-symlink scan), with `KEY_VARS` imported from `./secrets.js` and the manifest loaded once before the loop (move the existing `loadManifest` block up so `m` is available; keep behavior when no manifest):

```ts
    let m: Awaited<ReturnType<typeof loadManifest>> | null = null
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) m = await loadManifest(ctx.manifestRoot)
```

```ts
      const pname = lp.dirName === '.claude' ? 'default' : lp.dirName.slice('.claude-'.length)
      const decl = m?.profiles.find(p => p.name === pname) ?? null
      for (const varName of KEY_VARS)
        if (lp.settingsEnv[varName] && !decl?.settingsEnv[varName])
          problems.push(`plaintext token ${varName} in ${join(lp.dir, 'settings.json')} — adopt profile then run: secrets migrate`)
```

(and change the later manifest block to reuse `m` instead of re-loading.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/cli/test/ui-api-secrets.test.ts && npx vitest run packages/cli/test packages/core/test && npx tsc -b packages/core packages/cli`
Expected: PASS, no regressions, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/secrets.ts packages/cli/src/commands/profiles.ts packages/cli/src/ui/api.ts packages/cli/test/ui-api-secrets.test.ts
git commit -m "feat(cli): settings.json token migrate + doctor plaintext-token checks"
```

---

### Task 6: UI — provider section in editor + Provider column

**Files:**
- Modify: `packages/ui/src/components/ProfileEditor.tsx` (full rewrite below)
- Modify: `packages/ui/src/pages/ProfilesPage.tsx` (Provider column)

**Interfaces:**
- Consumes: profile rows now include `settingsEnv` (Task 4); `api.patchProfile` accepts `settingsEnv`.
- Produces: `ProfileRow` gains `settingsEnv: Record<string, string>` — SecretsPage imports this type (no changes needed there; the added field is backward-compatible).

- [ ] **Step 1: Rewrite `packages/ui/src/components/ProfileEditor.tsx`** — same behavior as current plus a second env section; the row editor is extracted so both sections share it:

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { X } from 'lucide-react'

export type ProfileRow = {
  name: string; dir: string; auth: string; account: string | null; mcp: number
  launcher: string | null; adopted: boolean
  env: Record<string, string>; links: Record<string, string>; mcpNames: string[]
  settingsEnv: Record<string, string>
}

const SECRET_PREFIX = 'secret://'
type EnvRow = { key: string; value: string; secret: boolean }
type KvRow = { key: string; value: string }

function toEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => value.startsWith(SECRET_PREFIX)
    ? { key, value: value.slice(SECRET_PREFIX.length), secret: true }
    : { key, value, secret: false })
}

function fromEnvRows(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.secret ? SECRET_PREFIX + r.value : r.value
  return out
}

function EnvRowsEditor({ rows, onChange, secretNames, keyPlaceholder }: {
  rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; secretNames: string[]; keyPlaceholder: string
}) {
  const setAt = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => j === i ? { ...r, ...patch } : r))
  return (
    <>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input className="w-56 font-mono text-xs" value={r.key} onChange={e => setAt(i, { key: e.target.value })} placeholder={keyPlaceholder} />
          {r.secret ? (
            <select className="flex-1 border rounded-md h-9 px-2 bg-background text-sm" value={r.value} onChange={e => setAt(i, { value: e.target.value })}>
              <option value="">— pick secret —</option>
              {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : (
            <Input className="flex-1 font-mono text-xs" value={r.value} onChange={e => setAt(i, { value: e.target.value })} />
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
            <input type="checkbox" checked={r.secret} onChange={e => setAt(i, { secret: e.target.checked, value: '' })} />secret
          </label>
          <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}>Add env var</Button>
    </>
  )
}

export function ProfileEditor({ profile, servers, secretNames, onClose, onSaved }: {
  profile: ProfileRow; servers: string[]; secretNames: string[]
  onClose: () => void; onSaved: () => void
}) {
  const [launcher, setLauncher] = useState(profile.launcher ?? '')
  const [env, setEnv] = useState<EnvRow[]>(toEnvRows(profile.env))
  const [senv, setSenv] = useState<EnvRow[]>(toEnvRows(profile.settingsEnv))
  const [links, setLinks] = useState<KvRow[]>(Object.entries(profile.links).map(([key, value]) => ({ key, value })))
  const [mcp, setMcp] = useState<string[]>(profile.mcpNames)
  const [saving, setSaving] = useState(false)

  const setLinkAt = (i: number, patch: Partial<KvRow>) => setLinks(links.map((r, j) => j === i ? { ...r, ...patch } : r))

  const save = async () => {
    for (const r of [...env, ...senv]) if (r.secret && !r.value) { toast.error(`pick a secret for ${r.key || 'env var'}`); return }
    setSaving(true)
    try {
      const linksObj: Record<string, string> = {}
      for (const r of links) if (r.key.trim()) linksObj[r.key.trim()] = r.value
      await api.patchProfile(profile.name, {
        env: fromEnvRows(env), settingsEnv: fromEnvRows(senv), links: linksObj, launcher: launcher.trim() || null,
      })
      for (const s of mcp.filter(s => !profile.mcpNames.includes(s))) await api.addMcp({ name: s, targets: [profile.name] })
      for (const s of profile.mcpNames.filter(s => !mcp.includes(s))) await api.rmMcp(s, [profile.name])
      toast.success(`Saved ${profile.name}`)
      onSaved()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {profile.name}</DialogTitle></DialogHeader>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label>Launcher function</Label>
            <Input value={launcher} onChange={e => setLauncher(e.target.value)} placeholder="cl-work (empty = no launcher)" />
          </div>

          <div className="space-y-1.5">
            <Label>Launcher env (exported by the shell function)</Label>
            <EnvRowsEditor rows={env} onChange={setEnv} secretNames={secretNames} keyPlaceholder="ANTHROPIC_API_KEY" />
          </div>

          <div className="space-y-1.5">
            <Label>Provider settings (settings.json env)</Label>
            <p className="text-xs text-muted-foreground">Base URL, auth token, model mappings — written into this profile's settings.json. Secret values resolve from the keychain on apply.</p>
            <EnvRowsEditor rows={senv} onChange={setSenv} secretNames={secretNames} keyPlaceholder="ANTHROPIC_BASE_URL" />
          </div>

          <div className="space-y-1.5">
            <Label>Links</Label>
            {links.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="w-56 font-mono text-xs" value={r.key} onChange={e => setLinkAt(i, { key: e.target.value })} placeholder="skills" />
                <Input className="flex-1 font-mono text-xs" value={r.value} onChange={e => setLinkAt(i, { value: e.target.value })} placeholder="hub or a path" />
                <Button size="sm" variant="ghost" onClick={() => setLinks(links.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setLinks([...links, { key: '', value: '' }])}>Add link</Button>
          </div>

          <div className="space-y-1.5">
            <Label>MCP servers</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {servers.map(s => (
                <label key={s} className="flex items-center gap-2 text-sm font-mono">
                  <input type="checkbox" checked={mcp.includes(s)}
                    onChange={e => setMcp(e.target.checked ? [...mcp, s] : mcp.filter(x => x !== s))} />{s}
                </label>
              ))}
              {servers.length === 0 && <div className="text-sm text-muted-foreground">No servers in manifest.</div>}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save & apply'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

(Compare with the current file before replacing: if the fix-wave version differs cosmetically — e.g. the save-guard message — keep the current file's behavior for existing parts and only add the new pieces: `settingsEnv` in ProfileRow, `fromEnvRows`, `EnvRowsEditor` extraction, `senv` state + section, `settingsEnv` in the PATCH body, save-guard covering `[...env, ...senv]`.)

- [ ] **Step 2: Add the Provider column to `packages/ui/src/pages/ProfilesPage.tsx`**:

Add a helper above the component:

```tsx
function providerHost(r: ProfileRow): string {
  const u = r.settingsEnv?.ANTHROPIC_BASE_URL
  if (!u) return '—'
  try { return new URL(u).host } catch { return u }
}
```

Add a header cell after `Launcher`: `<TableHead>Provider</TableHead>`, and a body cell after the launcher cell:

```tsx
              <TableCell className="font-mono text-xs text-muted-foreground">{providerHost(r)}</TableCell>
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: exits 0, no TS errors (SecretsPage still compiles — the added `settingsEnv` field is compatible).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/ProfileEditor.tsx packages/ui/src/pages/ProfilesPage.tsx
git commit -m "feat(ui): provider settings editor section + provider column"
```

---

### Task 7: Full suite + sandboxed end-to-end verify (acceptance example)

**Files:** none new (fixes only, if anything fails)

- [ ] **Step 1: Full build + tests**

Run: `npm run build && npm test`
Expected: build exits 0; all suites pass.

- [ ] **Step 2: Sandboxed e2e** — follow `/Users/lp-stf00543/Development/personal/ccprofiles/.claude/skills/verify/SKILL.md` (sandboxed home; NEVER the real `~/.claude*`). Reproduce the spec's acceptance example:

1. Sandbox home with `.claude-z/settings.json` containing exactly:
   `{ "env": { "ANTHROPIC_AUTH_TOKEN": "test-tok", "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic", "API_TIMEOUT_MS": "3000000", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air", "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1", "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2" }, "model": "opus" }` plus a `.claude.json` and a default `.claude` profile.
2. adopt → manifest profile `z` has all 7 settingsEnv keys.
3. secrets migrate → returns `anthropic-auth-token-z`; manifest flips to `secret://anthropic-auth-token-z`; keychain/file-backend holds `test-tok`; settings.json still has `test-tok`; `model: "opus"` untouched.
4. status → in sync (no settings-env drift after migrate).
5. Edit base URL via the API (PATCH settingsEnv with a different URL) → settings.json updated, other keys preserved.
6. doctor → quiet on the managed token; then hand-write an unmanaged token var into the default profile's settings.json → doctor flags it.

- [ ] **Step 3: Fix anything that failed, re-run covering tests, commit fixes** as `test: e2e verification fixes for settingsEnv provider config` (skip if nothing failed).
