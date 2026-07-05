# Cross-OS Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `clp` work on native Windows: accept remote (URL-only) MCP servers in the manifest, and add a passphrase-free Windows DPAPI secrets backend, with the UI surfacing an unavailable backend gracefully.

**Architecture:** Three independent fixes — (1) `McpServerSchema` allows `command` OR `url` + save-time round-trip validation; (2) new `DpapiBackend` in core secrets that DPAPI-encrypts values (via injectable PowerShell crypt) and stores ciphertext in a file, wired into `defaultBackend` for win32; (3) `GET /api/secrets` degrades to `backend:'unavailable'` instead of 500, with a UI setup card.

**Tech Stack:** Node 20+, TypeScript ESM, zod, vitest; React/Vite UI.

**Spec:** `docs/superpowers/specs/2026-07-06-cross-os-remote-mcp-dpapi-design.md`

## Global Constraints

- Run commands from repo root `~/Development/personal/ccprofiles`. Tests: `npx vitest run <file>`; full build `npm run build`; UI has no test runner (verify via build).
- Zero new native/npm dependencies. Windows crypto shells out to built-in PowerShell.
- Secret values must never appear on a process command line (argv) — pass via spawn env.
- Follow existing code style (compact, 2-space; UI files omit semicolons).
- Backends take an injectable exec/crypt so tests run on the macOS/Linux dev box without real PowerShell.
- Commit after each task with the message given.

---

### Task 1: Remote-aware MCP schema + save-time validation

**Files:**
- Modify: `packages/core/src/manifest.ts` (McpServerSchema ~line 11-17; saveManifest ~line 86-94)
- Test: `packages/core/test/manifest.test.ts`

**Interfaces:**
- Produces: `McpServerDef.command` becomes optional (`string | undefined`); a manifest is valid iff every mcp server has `command` or `url`. `saveManifest` throws (does not write) if the serialized manifest fails `parseManifest`.

- [ ] **Step 1: Write failing tests** — append to `packages/core/test/manifest.test.ts` (reuse its existing `parseManifest`/`serializeManifest`/temp helpers; add `saveManifest`, `loadManifest` to the import from the package source, and `mkdtemp`/`join`/`tmpdir` if not already imported):

```ts
describe('remote mcp servers', () => {
  const withServers = (servers: string) => `
version: 1
hub: null
profiles: []
mcpServers:
${servers}
`
  it('accepts a remote server with url and no command', () => {
    const m = parseManifest(withServers(`  clickup:\n    type: http\n    url: "https://mcp.clickup.com/x"`))
    expect(m.mcpServers.clickup.url).toBe('https://mcp.clickup.com/x')
    expect(m.mcpServers.clickup.command).toBeUndefined()
  })
  it('still accepts a local server with command', () => {
    const m = parseManifest(withServers(`  fs:\n    command: npx\n    args: ["-y", "server-fs"]`))
    expect(m.mcpServers.fs.command).toBe('npx')
  })
  it('rejects a server with neither command nor url', () => {
    expect(() => parseManifest(withServers(`  bad:\n    type: http`))).toThrow(/either "command".*or "url"/)
  })

  it('saveManifest round-trips a remote-server manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-savemcp-'))
    const m = parseManifest(withServers(`  clickup:\n    type: http\n    url: "https://mcp.clickup.com/x"`))
    await saveManifest(root, m)
    const reloaded = await loadManifest(root)
    expect(reloaded.mcpServers.clickup.url).toBe('https://mcp.clickup.com/x')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/manifest.test.ts`
Expected: FAIL — the remote-server test throws `mcpServers.clickup.command: Required`.

- [ ] **Step 3: Implement** — in `packages/core/src/manifest.ts`:

Replace `McpServerSchema`:

```ts
const McpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  type: z.string().optional(),
  url: z.string().optional(),
}).passthrough().refine(
  s => s.command !== undefined || s.url !== undefined,
  { message: 'mcp server must have either "command" (local) or "url" (remote)' },
)
```

In `saveManifest`, validate before writing. Current body starts:

```ts
export async function saveManifest(root: string, m: Manifest): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.yaml'), serializeManifest(m), 'utf8')
```

Change to serialize once, round-trip check, then write:

```ts
export async function saveManifest(root: string, m: Manifest): Promise<void> {
  const yaml = serializeManifest(m)
  parseManifest(yaml) // guard: never write a manifest that cannot be reloaded
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.yaml'), yaml, 'utf8')
```

(Leave the git add/commit block below unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/manifest.test.ts && npx tsc -b packages/core packages/cli`
Expected: tests PASS; build clean (confirms no call site dereferences a now-optional `.command`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/test/manifest.test.ts
git commit -m "fix(core): accept remote (url-only) mcp servers; validate manifest on save"
```

---

### Task 2: DpapiBackend + defaultBackend win32 wiring

**Files:**
- Modify: `packages/core/src/secrets.ts`
- Test: `packages/core/test/secrets.test.ts`

**Interfaces:**
- Consumes: existing `SecretsBackend` interface, `atomicWrite`, `Platform`.
- Produces:
  - `type DpapiCrypt = { protect(plain: string): Promise<string>; unprotect(b64: string): Promise<string> }`
  - `class DpapiBackend implements SecretsBackend` (`name = 'windows-dpapi'`), constructor `(filePath: string, crypt?: DpapiCrypt)`.
  - `defaultBackend` returns `DpapiBackend` on win32 when the PowerShell DPAPI probe succeeds, else the encrypted-file path.

- [ ] **Step 1: Write failing tests** — append to `packages/core/test/secrets.test.ts` (reuse its temp-file style; import `DpapiBackend` and any helpers from the package source):

```ts
describe('DpapiBackend', () => {
  // Fake DPAPI: base64 round-trip stands in for real PowerShell/ProtectedData.
  const fakeCrypt = {
    protect: async (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
    unprotect: async (b64: string) => Buffer.from(b64, 'base64').toString('utf8'),
  }
  it('set/get/delete round-trips via the injected crypt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-dpapi-'))
    const b = new DpapiBackend(join(dir, 'secrets.dpapi.json'), fakeCrypt)
    expect(await b.get('missing')).toBeNull()
    await b.set('k', 'super-secret')
    expect(await b.get('k')).toBe('super-secret')
    await b.delete('k')
    expect(await b.get('k')).toBeNull()
  })
  it('persists ciphertext, not plaintext, on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-dpapi2-'))
    const file = join(dir, 'secrets.dpapi.json')
    await new DpapiBackend(file, fakeCrypt).set('k', 'plaintext-value')
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('plaintext-value')
  })
})
```

(Ensure the file imports `mkdtemp` from `node:fs/promises`, `readFile` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, and `DpapiBackend` from the source module the other backends come from.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/secrets.test.ts`
Expected: FAIL — `DpapiBackend` is not exported.

- [ ] **Step 3: Implement** — in `packages/core/src/secrets.ts`, after `SecretToolBackend`:

```ts
export type DpapiCrypt = { protect(plain: string): Promise<string>; unprotect(b64: string): Promise<string> }

// DPAPI via built-in PowerShell. Secret bytes travel through a spawn env var, never argv.
export const powershellDpapi: DpapiCrypt = {
  protect: (plain) => runDpapi(
    "$b=[Text.Encoding]::UTF8.GetBytes($env:CCP_IN);" +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))",
    plain),
  unprotect: (b64) => runDpapi(
    "$b=[Convert]::FromBase64String($env:CCP_IN);" +
    "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
    b64),
}

async function runDpapi(script: string, input: string): Promise<string> {
  const child = await import('node:child_process')
  return new Promise<string>((resolve, reject) => {
    const proc = child.spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security;' + script],
      { env: { ...process.env, CCP_IN: input }, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    proc.stdout.on('data', d => { out += d })
    proc.on('error', reject)
    proc.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell dpapi exited ${code}`))))
  })
}

type DpapiFile = { entries: Record<string, string> } // key -> DPAPI ciphertext (base64)

export class DpapiBackend implements SecretsBackend {
  readonly name = 'windows-dpapi'
  constructor(private filePath: string, private crypt: DpapiCrypt = powershellDpapi) {}
  private async load(): Promise<DpapiFile> {
    if (!existsSync(this.filePath)) return { entries: {} }
    return JSON.parse(await readFile(this.filePath, 'utf8'))
  }
  async get(key: string): Promise<string | null> {
    const f = await this.load()
    const ct = f.entries[key]
    return ct === undefined ? null : this.crypt.unprotect(ct)
  }
  async set(key: string, value: string): Promise<void> {
    const f = await this.load()
    f.entries[key] = await this.crypt.protect(value)
    await atomicWrite(this.filePath, JSON.stringify(f))
  }
  async delete(key: string): Promise<void> {
    const f = await this.load()
    delete f.entries[key]
    await atomicWrite(this.filePath, JSON.stringify(f))
  }
}
```

Wire into `defaultBackend` — add a win32 branch after the `linux` branch and before the `const pw = ...` fallback. No PowerShell probe here: Windows ships PowerShell on every supported release, spawning it twice per `defaultBackend` call (which the UI does per request) is too slow, and if DPAPI genuinely fails a real `get`/`set` throws and is caught by the UI's graceful-degrade path (Task 3). If a passphrase is set, the CLI `secretsStore` already short-circuits to `FileBackend` before ever reaching here, so that remains the escape hatch on a DPAPI-less box.

```ts
  if (p.os === 'win32') return new DpapiBackend(opts.filePath.replace(/\.enc$/, '.dpapi.json'))
```

Confirm the derived path is distinct from the encrypted-file path: `opts.filePath` is the `secretsFilePath` (`secrets.enc`), so DPAPI storage becomes `secrets.dpapi.json` in the same dir — the two backends never share a file.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/secrets.test.ts && npx tsc -b packages/core packages/cli`
Expected: tests PASS; build clean. (The win32 probe code is not exercised on the dev OS.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/secrets.ts packages/core/test/secrets.test.ts
git commit -m "feat(core): Windows DPAPI secrets backend (passphrase-free, no native deps)"
```

---

### Task 3: UI degrades gracefully when the secrets backend is unavailable

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (GET /api/secrets route)
- Modify: `packages/ui/src/pages/SecretsPage.tsx`
- Test: `packages/cli/test/ui-api-secrets.test.ts`

**Interfaces:**
- Consumes: `secretsStore(ctx)` (throws when no backend is available).
- Produces: `GET /api/secrets` → `{ names: string[]; backend: string; error?: string }`; `backend === 'unavailable'` with empty names when the store cannot open (HTTP 200, not 500). SecretsPage shows a setup card in that state.

- [ ] **Step 1: Write the failing test** — append to `packages/cli/test/ui-api-secrets.test.ts`. Simulate an unavailable backend by building a context whose secrets store cannot open: use a non-darwin/non-linux platform with no passphrase. Check how the test helpers build `ctx`; the simplest trigger is a context where `secretsStore` throws. Add:

```ts
  it('GET /api/secrets returns backend "unavailable" instead of 500 when the store cannot open', async () => {
    // Force the encrypted-file backend with no passphrase by clearing CCPROFILES_PASSPHRASE
    // and using a platform the default backend cannot serve without one.
    const badCtx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh', CCPROFILES_FORCE_OS: 'win32' } as any)
    const res = await callApi(badCtx, 'GET', '/api/secrets')
    expect(res._status).toBe(200)
    expect(res._json.backend).toBe('unavailable')
    expect(res._json.names).toEqual([])
  })
```

If `makeContext`/`detectPlatform` has no OS override hook, instead assert the behavior by monkeypatching: import the route through `callApi` after setting the env so `secretsStore` throws (no passphrase + a platform whose defaultBackend needs one). Inspect `packages/cli/src/context.ts` and `packages/core/src/platform.ts` first; if `CCPROFILES_FORCE_OS` does not exist, add a minimal test seam: in `detectPlatform`, honor `env.CCPROFILES_FORCE_OS` when set (documented as test-only) OR construct the failing store by omitting the passphrase on a win32 test platform. Choose whichever requires the smaller, clearly test-only change and note it in the report.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/cli/test/ui-api-secrets.test.ts`
Expected: FAIL — route currently throws → non-200 status.

- [ ] **Step 3: Implement** — in `packages/cli/src/ui/api.ts`, wrap the GET /api/secrets handler:

```ts
  add('GET', /^\/api\/secrets$/, async (_m, _req, res) => {
    let store
    try { store = await secretsStore(ctx) }
    catch (e) { return sendJson(res, 200, { names: [], backend: 'unavailable', error: (e as Error).message }) }
    sendJson(res, 200, { names: await store.list(), backend: store.backendName })
  })
```

In `packages/ui/src/pages/SecretsPage.tsx`, when `backend === 'unavailable'` render a setup card instead of the normal add/list controls. After the existing state/load logic, add near the top of the returned JSX (keep the heading), e.g.:

```tsx
      {backend === 'unavailable' ? (
        <div className="border rounded-lg p-4 text-sm space-y-1">
          <div className="font-medium">Secrets backend not configured</div>
          <p className="text-muted-foreground">
            On Windows this uses DPAPI automatically (needs PowerShell). Otherwise set
            <span className="font-mono"> CCPROFILES_PASSPHRASE</span> in your environment to enable the encrypted-file backend, then reopen this page.
          </p>
        </div>
      ) : (
        /* existing add-secret + list UI */
      )}
```

Wire the existing content into the `else` branch (wrap the current toolbar + list JSX). Ensure `backend` state is already populated from `api.secrets()` (it is).

- [ ] **Step 4: Verify**

Run: `npx vitest run packages/cli/test/ui-api-secrets.test.ts && npm run build`
Expected: test PASS; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/ui/src/pages/SecretsPage.tsx packages/cli/test/ui-api-secrets.test.ts packages/cli/src/context.ts packages/core/src/platform.ts
git commit -m "fix(ui): degrade secrets tab gracefully when no backend is available"
```

(Only stage `context.ts`/`platform.ts` if the test seam required touching them.)

---

### Task 4: Full suite + sandboxed e2e

**Files:** none new (fixes only, if anything fails)

- [ ] **Step 1: Full build + tests**

Run: `npm run build && npm test`
Expected: build exits 0; all suites pass.

- [ ] **Step 2: Sandboxed e2e** — follow `.claude/skills/verify/SKILL.md` (sandboxed home; never the real `~/.claude*`). Verify:
  1. A profile whose live `.claude.json` has a remote MCP server (`{ "type":"http","url":"https://mcp.clickup.com/x" }` under `mcpServers`) → `adopt` → `GET /api/profiles` returns 200 (manifest loads), and the manifest on disk contains the clickup url entry.
  2. `saveManifest` guard: attempting to persist a manifest with a command-less/url-less server throws (already unit-tested; spot-confirm adopt of a valid remote server does NOT throw).
  3. `DpapiBackend` unit path already covered; no real-Windows run needed.

- [ ] **Step 3: Fix anything that failed, re-run covering tests, commit** as `test: e2e verification fixes for cross-os` (skip if nothing failed).
