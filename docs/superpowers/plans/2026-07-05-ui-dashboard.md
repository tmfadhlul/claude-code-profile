# ccprofiles UI Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `clp ui` command that opens a localhost web dashboard (React + shadcn/ui) to manage profiles, secrets, MCP servers, sync, status/apply, and doctor — everything the CLI does — over a token-authenticated JSON API layered on `ccprofiles-core`.

**Architecture:** A framework-free Node `http` server in the CLI package serves a token-guarded JSON API (thin wrappers over `core`) plus the statically-built React SPA. The SPA lives in a new `packages/ui` (Vite + React + shadcn/ui); its build output is copied into `packages/cli/dist/ui/` and shipped in the npm tarball. No runtime framework deps added to the CLI.

**Tech Stack:** Node `http` (server), TypeScript/ESM, Vite + React 18 + Tailwind + shadcn/ui (frontend, build-time only), vitest (API tests), Playwright MCP (one smoke test).

## Global Constraints

- Node ≥ 20, ESM only. CLI runtime deps stay `ccprofiles-core` + `commander` (server uses only `node:*`).
- UI server binds `127.0.0.1` ONLY — never `0.0.0.0`.
- Every `/api/*` request requires header `X-CCP-Token` matching the launch token (constant-time compare) → else 401. Reject `/api/*` when an `Origin` header is present and not `http://127.0.0.1:<port>` or `http://localhost:<port>` → 403.
- Mutations reuse the existing plan→apply path with backups (`planApply`/`executeApply`). Never touch sessions/history/caches.
- UI build output is self-contained: no external CDN/host references at runtime.
- Package version bumps at ship: `claude-account-sync` → 0.2.0. `ccprofiles-core` only if its `src` changes (then patch-bump).
- Secret values leave the machine only over this authenticated localhost channel; `list` returns names only, `GET /api/secrets/:name` returns the value.

## File Structure

```
packages/cli/src/ui/
  token.ts          # generateToken, constant-time check, origin check   (Task 2)
  api.ts            # ApiDeps + handleApi(req,res,ctx): routes → core     (Tasks 3–6)
  static.ts         # serveStatic: map non-/api paths to dist/ui files    (Task 7)
  server.ts         # startUiServer(ctx,{port,token}): wires token+api+static (Task 7)
  command.ts        # registerUiCommand: `clp ui [--port][--no-open]`     (Task 8)
packages/ui/        # Vite React app                                       (Tasks 9–13)
scripts/copy-ui.mjs # copy packages/ui/dist → packages/cli/dist/ui        (Task 14)
```

---

### Task 1: API request/response plumbing (readJson, sendJson, Router)

**Files:**
- Create: `packages/cli/src/ui/http.ts`
- Test: `packages/cli/test/ui-http.test.ts`

**Interfaces:**
- Produces:
  - `readBody(req: IncomingMessage): Promise<string>`
  - `readJson<T=any>(req: IncomingMessage): Promise<T>` (throws `BadRequest` on invalid JSON)
  - `sendJson(res: ServerResponse, code: number, body: unknown): void`
  - `class BadRequest extends Error` and `class HttpError extends Error { constructor(public status: number, msg: string) }`
  - `type Route = { method: string; pattern: RegExp; handler: (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse) => Promise<void> }`
  - `matchRoute(routes: Route[], method: string, path: string): { route: Route; match: RegExpMatchArray } | null`

- [ ] **Step 1: Write failing tests**

`packages/cli/test/ui-http.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { matchRoute, sendJson, HttpError, type Route } from '../src/ui/http.js'

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/secrets$/, handler: async () => {} },
  { method: 'GET', pattern: /^\/api\/secrets\/([^/]+)$/, handler: async () => {} },
]

describe('matchRoute', () => {
  it('matches a static route', () => {
    const r = matchRoute(routes, 'GET', '/api/secrets')
    expect(r?.route.pattern.source).toBe('^\\/api\\/secrets$')
  })
  it('captures a param', () => {
    const r = matchRoute(routes, 'GET', '/api/secrets/api-key')
    expect(r?.match[1]).toBe('api-key')
  })
  it('returns null on method mismatch', () => {
    expect(matchRoute(routes, 'POST', '/api/secrets')).toBeNull()
  })
  it('returns null on no path match', () => {
    expect(matchRoute(routes, 'GET', '/api/nope')).toBeNull()
  })
})

describe('HttpError', () => {
  it('carries a status', () => {
    expect(new HttpError(409, 'x').status).toBe(409)
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run packages/cli/test/ui-http.test.ts` → FAIL (module missing)

- [ ] **Step 3: Implement**

`packages/cli/src/ui/http.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export class BadRequest extends HttpError {
  constructor(message = 'invalid request') { super(400, message) }
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJson<T = any>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req)
  if (!raw) return {} as T
  try { return JSON.parse(raw) as T } catch { throw new BadRequest('invalid JSON body') }
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export type Route = {
  method: string
  pattern: RegExp
  handler: (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse) => Promise<void>
}

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; match: RegExpMatchArray } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const match = path.match(route.pattern)
    if (match) return { route, match }
  }
  return null
}
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): http plumbing (readJson, sendJson, router, HttpError)"`

---

### Task 2: Token + origin guard

**Files:**
- Create: `packages/cli/src/ui/token.ts`
- Test: `packages/cli/test/ui-token.test.ts`

**Interfaces:**
- Produces:
  - `newUiToken(): string` — `randomBytes(32).toString('base64url')`
  - `tokenOk(provided: string | undefined, expected: string): boolean` — constant-time; false if missing/length-mismatch
  - `originOk(origin: string | undefined, port: number): boolean` — true if absent, or exactly `http://127.0.0.1:<port>` / `http://localhost:<port>`

- [ ] **Step 1: Write failing tests**

`packages/cli/test/ui-token.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { newUiToken, tokenOk, originOk } from '../src/ui/token.js'

describe('ui token', () => {
  it('generates distinct urlsafe tokens', () => {
    const a = newUiToken(), b = newUiToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('accepts the exact token, rejects wrong/missing', () => {
    const t = newUiToken()
    expect(tokenOk(t, t)).toBe(true)
    expect(tokenOk('nope', t)).toBe(false)
    expect(tokenOk(undefined, t)).toBe(false)
  })
})

describe('origin guard', () => {
  it('allows absent origin (same-process/curl)', () => {
    expect(originOk(undefined, 5000)).toBe(true)
  })
  it('allows loopback origins on the right port', () => {
    expect(originOk('http://127.0.0.1:5000', 5000)).toBe(true)
    expect(originOk('http://localhost:5000', 5000)).toBe(true)
  })
  it('rejects foreign origins and wrong ports', () => {
    expect(originOk('http://evil.com', 5000)).toBe(false)
    expect(originOk('http://127.0.0.1:5001', 5000)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/cli/src/ui/token.ts`:
```ts
import { randomBytes, timingSafeEqual } from 'node:crypto'

export function newUiToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided), b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export function originOk(origin: string | undefined, port: number): boolean {
  if (!origin) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): session token + origin guard"`

---

### Task 3: API context + profiles/adopt/status/apply/doctor handlers

**Files:**
- Create: `packages/cli/src/ui/api.ts`
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Consumes: `Route`, `sendJson`, `readJson`, `HttpError` (http.ts); `CliContext`, `requireManifest` (context.ts); `secretsStore` (commands/secrets.ts); core functions.
- Produces:
  - `buildRoutes(ctx: CliContext): Route[]` — the full route table (extended in Tasks 4–6).
  - Internal helper `stamp()`, `applyAndReport(ctx, m)`.
  - Handlers implemented here: `POST /api/adopt`, `GET /api/profiles`, `POST /api/profiles`, `PATCH /api/profiles/:name`, `GET /api/status`, `POST /api/apply`, `GET /api/doctor`.
- JSON shapes:
  - profiles row: `{ name: string; dir: string; auth: string; account: string|null; mcp: number; launcher: string|null; adopted: boolean }`
  - status: `{ inSync: boolean; pending: string[] }`
  - apply: `{ performed: string[]; backupDir: string|null }`
  - doctor: `{ problems: string[] }`

- [ ] **Step 1: Write failing tests**

`packages/cli/test/ui-api-core.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { makeContext } from '../src/context.js'
import { buildRoutes } from '../src/ui/api.js'
import { matchRoute } from '../src/ui/http.js'

// Minimal fake req/res to invoke a route handler directly.
function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = method; req.url = url
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}
function fakeRes(): ServerResponse & { _status?: number; _json?: any } {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as any
  let chunks = ''
  res.writeHead = (code: number) => { res._status = code; return res }
  res.end = (t?: string) => { if (t) { chunks += t; try { res._json = JSON.parse(chunks) } catch {} } return res }
  res.write = (t: string) => { chunks += t; return true }
  return res
}
async function call(ctx: any, method: string, path: string, body?: unknown) {
  const routes = buildRoutes(ctx)
  const m = matchRoute(routes, method, path)
  if (!m) throw new Error(`no route ${method} ${path}`)
  const res = fakeRes()
  await m.route.handler(m.match, fakeReq(method, path, body), res)
  return res
}

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uiapi-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: adopt/profiles/status/apply/doctor', () => {
  it('adopt then profiles lists the discovered profile', async () => {
    await call(ctx, 'POST', '/api/adopt')
    const res = await call(ctx, 'GET', '/api/profiles')
    expect(res._json.find((p: any) => p.name === 'default').account).toBe('a@b.c')
  })
  it('status is not-in-sync before apply, in-sync after', async () => {
    await call(ctx, 'POST', '/api/adopt')
    expect((await call(ctx, 'GET', '/api/status'))._json.inSync).toBe(false)
    await call(ctx, 'POST', '/api/apply')
    expect((await call(ctx, 'GET', '/api/status'))._json.inSync).toBe(true)
  })
  it('create profile via POST', async () => {
    await call(ctx, 'POST', '/api/adopt')
    await call(ctx, 'POST', '/api/profiles', { name: 'work', from: 'default' })
    const names = (await call(ctx, 'GET', '/api/profiles'))._json.map((p: any) => p.name)
    expect(names).toContain('work')
  })
  it('doctor returns problems array', async () => {
    const res = await call(ctx, 'GET', '/api/doctor')
    expect(Array.isArray(res._json.problems)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL

- [ ] **Step 3: Implement**

`packages/cli/src/ui/api.ts`:
```ts
import {
  discoverProfiles, buildManifest, saveManifest, planApply, executeApply,
  ensureRootGitignore, loadManifest, type Manifest,
} from 'ccprofiles-core'
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireManifest, type CliContext } from '../context.js'
import { sendJson, readJson, HttpError, type Route } from './http.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

async function applyAndReport(ctx: CliContext, m: Manifest) {
  const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
  return executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
}

function profileName(dirName: string): string {
  return dirName === '.claude' ? 'default' : dirName.slice('.claude-'.length)
}

export function buildRoutes(ctx: CliContext): Route[] {
  const routes: Route[] = []
  const add = (method: string, pattern: RegExp, handler: Route['handler']) => routes.push({ method, pattern, handler })

  add('POST', /^\/api\/adopt$/, async (_m, _req, res) => {
    const manifest = buildManifest(await discoverProfiles(ctx.home), ctx.platform)
    if (!existsSync(join(ctx.manifestRoot, '.git'))) {
      try { execFileSync('git', ['init', ctx.manifestRoot], { stdio: 'ignore' }) } catch { /* git optional */ }
    }
    await ensureRootGitignore(ctx.manifestRoot)
    await saveManifest(ctx.manifestRoot, manifest)
    sendJson(res, 200, { profiles: manifest.profiles.length, mcpServers: Object.keys(manifest.mcpServers).length })
  })

  add('GET', /^\/api\/profiles$/, async (_m, _req, res) => {
    const live = await discoverProfiles(ctx.home)
    let manifest: Manifest | null = null
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) manifest = await loadManifest(ctx.manifestRoot)
    const rows = live.map(lp => {
      const name = profileName(lp.dirName)
      const decl = manifest?.profiles.find(p => p.name === name) ?? null
      return {
        name, dir: lp.dir, auth: decl?.auth ?? (lp.account ? 'oauth' : 'env'),
        account: lp.account, mcp: Object.keys(lp.mcpServers).length,
        launcher: decl?.launcher ?? (name === 'default' ? null : `cl-${name}`),
        adopted: !!decl,
      }
    })
    sendJson(res, 200, rows)
  })

  add('POST', /^\/api\/profiles$/, async (_m, req, res) => {
    const { name, from } = await readJson<{ name: string; from?: string }>(req)
    if (!name) throw new HttpError(400, 'name required')
    const m = await requireManifest(ctx)
    if (m.profiles.some(p => p.name === name)) throw new HttpError(409, `profile exists: ${name}`)
    const src = from ? m.profiles.find(p => p.name === from) : null
    if (from && !src) throw new HttpError(400, `unknown profile: ${from}`)
    m.profiles.push({
      name, dir: `{home}/.claude-${name}`, launcher: `cl-${name}`, auth: 'env', env: {},
      links: src ? { ...src.links } : (m.hub ? { skills: 'hub', commands: 'hub' } : {}),
      mcp: src ? [...src.mcp] : [],
    })
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(ctx, m)
    sendJson(res, 200, { ok: true })
  })

  add('PATCH', /^\/api\/profiles\/([^/]+)$/, async (mtch, req, res) => {
    const m = await requireManifest(ctx)
    const pr = m.profiles.find(p => p.name === mtch[1])
    if (!pr) throw new HttpError(404, `unknown profile: ${mtch[1]}`)
    const body = await readJson<{ env?: Record<string, string>; links?: Record<string, string>; launcher?: string | null }>(req)
    if (body.env) pr.env = body.env
    if (body.links) pr.links = body.links
    if (body.launcher !== undefined) pr.launcher = body.launcher
    await saveManifest(ctx.manifestRoot, m)   // parseManifest/assertSafeManifest runs on next load
    await applyAndReport(ctx, m)
    sendJson(res, 200, { ok: true })
  })

  add('GET', /^\/api\/status$/, async (_m, _req, res) => {
    const m = await requireManifest(ctx)
    const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: true })
    sendJson(res, 200, { inSync: actions.length === 0, pending: r.performed })
  })

  add('POST', /^\/api\/apply$/, async (_m, _req, res) => {
    const m = await requireManifest(ctx)
    const r = await applyAndReport(ctx, m)
    sendJson(res, 200, { performed: r.performed, backupDir: r.backupDir })
  })

  add('GET', /^\/api\/doctor$/, async (_m, _req, res) => {
    const problems: string[] = []
    const live = await discoverProfiles(ctx.home)
    for (const lp of live)
      for (const nm of readdirSync(lp.dir)) {
        const f = join(lp.dir, nm)
        try { if (lstatSync(f).isSymbolicLink() && !existsSync(f)) problems.push(`broken symlink: ${f} -> ${readlinkSync(f)}`) } catch { /* skip */ }
      }
    if (existsSync(ctx.platform.rcFile)) {
      const rc = readFileSync(ctx.platform.rcFile, 'utf8')
      const outside = rc.split('# >>> ccprofiles managed >>>')[0] + (rc.split('# <<< ccprofiles managed <<<')[1] ?? '')
      if (/sk-ant-/.test(outside)) problems.push(`plaintext Anthropic key in ${ctx.platform.rcFile} — run secrets migrate`)
    }
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const m = await loadManifest(ctx.manifestRoot)
      for (const pr of m.profiles) {
        const dir = pr.dir.replace('{home}', ctx.home)
        if (!existsSync(dir)) problems.push(`manifest profile "${pr.name}" missing on disk: ${dir} — run apply`)
      }
    }
    sendJson(res, 200, { problems })
  })

  return routes
}
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): api routes for adopt/profiles/status/apply/doctor"`

---

### Task 4: MCP handlers

**Files:**
- Modify: `packages/cli/src/ui/api.ts`
- Test: `packages/cli/test/ui-api-mcp.test.ts`

**Interfaces:**
- Consumes: everything in Task 3.
- Produces (added to `buildRoutes`): `GET /api/mcp`, `POST /api/mcp`, `DELETE /api/mcp/:name`, `POST /api/mcp/sync`.
- JSON: `GET /api/mcp` → `{ servers: string[]; profiles: { name: string; has: string[] }[] }`.

- [ ] **Step 1: Write failing tests**

`packages/cli/test/ui-api-mcp.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { makeContext } from '../src/context.js'
import { buildRoutes } from '../src/ui/api.js'
import { matchRoute } from '../src/ui/http.js'

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket()); req.method = method; req.url = url
  process.nextTick(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  return req
}
function fakeRes(): any {
  const res: any = new ServerResponse(new IncomingMessage(new Socket())); let chunks = ''
  res.writeHead = (c: number) => { res._status = c; return res }
  res.end = (t?: string) => { if (t) { chunks += t; try { res._json = JSON.parse(chunks) } catch {} } return res }
  res.write = (t: string) => { chunks += t; return true }
  return res
}
async function call(ctx: any, method: string, path: string, body?: unknown) {
  const m = matchRoute(buildRoutes(ctx), method, path)
  if (!m) throw new Error(`no route ${method} ${path}`)
  const res = fakeRes(); await m.route.handler(m.match, fakeReq(method, path, body), res); return res
}

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uimcp-'))
  await mkdir(join(home, '.claude')); await mkdir(join(home, '.claude-work'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await call(ctx, 'POST', '/api/adopt')
})

describe('ui api: mcp', () => {
  it('GET returns matrix', async () => {
    const r = await call(ctx, 'GET', '/api/mcp')
    expect(r._json.servers).toContain('playwright')
    expect(r._json.profiles.find((p: any) => p.name === 'default').has).toContain('playwright')
    expect(r._json.profiles.find((p: any) => p.name === 'work').has).not.toContain('playwright')
  })
  it('POST adds a server to all and writes live config', async () => {
    await call(ctx, 'POST', '/api/mcp', { name: 'shadcn', command: 'npx', args: ['shadcn@latest', 'mcp'], targets: 'all' })
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(cfg.mcpServers.shadcn.args).toEqual(['shadcn@latest', 'mcp'])
  })
  it('sync copies mcp set between profiles', async () => {
    await call(ctx, 'POST', '/api/mcp/sync', { from: 'default', to: ['work'] })
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
  })
  it('DELETE removes from targets', async () => {
    await call(ctx, 'DELETE', '/api/mcp/playwright', { targets: 'all' })
    const r = await call(ctx, 'GET', '/api/mcp')
    expect(r._json.servers).not.toContain('playwright')
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL

- [ ] **Step 3: Implement** — add to `buildRoutes` in `api.ts`, before `return routes`:

```ts
  function targetsOf(m: Manifest, targets: string[] | 'all'): string[] {
    if (targets === 'all') return m.profiles.map(p => p.name)
    for (const t of targets) if (!m.profiles.some(p => p.name === t)) throw new HttpError(400, `unknown profile: ${t}`)
    return targets
  }

  add('GET', /^\/api\/mcp$/, async (_m, _req, res) => {
    const m = await requireManifest(ctx)
    sendJson(res, 200, {
      servers: Object.keys(m.mcpServers).sort(),
      profiles: m.profiles.map(p => ({ name: p.name, has: p.mcp })),
    })
  })

  add('POST', /^\/api\/mcp$/, async (_m, req, res) => {
    const { name, command, args, targets } = await readJson<{ name: string; command?: string; args?: string[]; targets: string[] | 'all' }>(req)
    if (!name) throw new HttpError(400, 'name required')
    const m = await requireManifest(ctx)
    if (!m.mcpServers[name]) {
      if (!command) throw new HttpError(400, `unknown server "${name}" — command required to define it`)
      m.mcpServers[name] = { command, ...(args && args.length ? { args } : {}) }
    }
    for (const t of targetsOf(m, targets)) {
      const pr = m.profiles.find(p => p.name === t)!
      if (!pr.mcp.includes(name)) pr.mcp.push(name)
    }
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(ctx, m)
    sendJson(res, 200, { ok: true })
  })

  add('DELETE', /^\/api\/mcp\/([^/]+)$/, async (mtch, req, res) => {
    const { targets } = await readJson<{ targets: string[] | 'all' }>(req)
    const m = await requireManifest(ctx)
    for (const t of targetsOf(m, targets)) {
      const pr = m.profiles.find(p => p.name === t)!
      pr.mcp = pr.mcp.filter(x => x !== mtch[1])
    }
    if (!m.profiles.some(p => p.mcp.includes(mtch[1]))) delete m.mcpServers[mtch[1]]
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(ctx, m)
    sendJson(res, 200, { ok: true })
  })

  add('POST', /^\/api\/mcp\/sync$/, async (_m, req, res) => {
    const { from, to } = await readJson<{ from: string; to: string[] | 'all' }>(req)
    const m = await requireManifest(ctx)
    const src = m.profiles.find(p => p.name === from)
    if (!src) throw new HttpError(400, `unknown profile: ${from}`)
    for (const t of targetsOf(m, to)) {
      if (t === src.name) continue
      m.profiles.find(p => p.name === t)!.mcp = [...src.mcp]
    }
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(ctx, m)
    sendJson(res, 200, { ok: true })
  })
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): api routes for mcp matrix/add/remove/sync"`

---

### Task 5: Secrets handlers (list/reveal/set/delete/migrate)

**Files:**
- Modify: `packages/cli/src/ui/api.ts`
- Test: `packages/cli/test/ui-api-secrets.test.ts`

**Interfaces:**
- Consumes: `secretsStore(ctx)` from `commands/secrets.ts`, plus the migrate regex logic. To avoid duplication, extract the migrate logic in Task 5 into an exported helper.
- Produces (added): `GET /api/secrets`, `GET /api/secrets/:name`, `PUT /api/secrets/:name`, `DELETE /api/secrets/:name`, `POST /api/secrets/migrate`.
- Also: **refactor** — extract `migrateRcSecrets(ctx): Promise<string[]>` into `commands/secrets.ts` and have both the CLI `migrate` command and the API call it. (DRY; the CLI currently inlines it.)

- [ ] **Step 1: Refactor first — export the migrate helper**

In `packages/cli/src/commands/secrets.ts`, extract the body of the `migrate` action into an exported function and call it from both places:

```ts
// add near the top-level exports
export async function migrateRcSecrets(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const rcFile = ctx.platform.rcFile
  if (!existsSync(rcFile)) return []
  const store = await secretsStore(ctx)
  const lines = (await readFile(rcFile, 'utf8')).split('\n')
  const migrated: string[] = []
  const out: string[] = []
  for (const line of lines) {
    const pwsh = line.match(MIGRATE_RE_PWSH)
    const posix = pwsh ? null : line.match(MIGRATE_RE_POSIX)
    const match = pwsh ?? posix
    if (!match) { out.push(line); continue }
    const [, prefix, varName, secretValue, suffix] = match
    const secretName = varName.toLowerCase().replaceAll('_', '-')
    if (!opts.dryRun) await store.set(secretName, secretValue)
    out.push(pwsh ? `${prefix}(ccprofiles secrets get ${secretName})${suffix}` : `${prefix}"$(ccprofiles secrets get ${secretName})"${suffix}`)
    migrated.push(secretName)
  }
  if (migrated.length && !opts.dryRun) {
    await backupFiles([rcFile], ctx.backupRoot, new Date().toISOString().replace(/[:.]/g, '-'))
    await atomicWrite(rcFile, out.join('\n'))
  }
  return migrated
}
```
Then in the `migrate` command action, replace the inlined loop with:
```ts
  sec.command('migrate').option('--dry-run').action(async (opts: { dryRun?: boolean }) => {
    const migrated = await migrateRcSecrets(ctx, opts)
    if (migrated.length === 0) { console.log('no plaintext keys found'); return }
    for (const n of migrated) console.log(`${opts.dryRun ? '[dry-run] ' : ''}migrated ${n}`)
  })
```
Keep `MIGRATE_RE_PWSH`/`MIGRATE_RE_POSIX`/`KEY_VARS` where they are (module scope) so the helper sees them.

- [ ] **Step 2: Verify CLI secrets tests still pass** — `npx vitest run packages/cli/test/secrets.test.ts` → PASS (refactor is behavior-preserving)

- [ ] **Step 3: Write failing API tests**

`packages/cli/test/ui-api-secrets.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { makeContext } from '../src/context.js'
import { buildRoutes } from '../src/ui/api.js'
import { matchRoute } from '../src/ui/http.js'

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket()); req.method = method; req.url = url
  process.nextTick(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  return req
}
function fakeRes(): any {
  const res: any = new ServerResponse(new IncomingMessage(new Socket())); let chunks = ''
  res.writeHead = (c: number) => { res._status = c; return res }
  res.end = (t?: string) => { if (t) { chunks += t; try { res._json = JSON.parse(chunks) } catch {} } return res }
  res.write = (t: string) => { chunks += t; return true }
  return res
}
async function call(ctx: any, method: string, path: string, body?: unknown) {
  const m = matchRoute(buildRoutes(ctx), method, path)
  if (!m) throw new Error(`no route ${method} ${path}`)
  const res = fakeRes(); await m.route.handler(m.match, fakeReq(method, path, body), res); return res
}

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uisec-'))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: secrets', () => {
  it('set, list (names only), reveal, delete', async () => {
    await call(ctx, 'PUT', '/api/secrets/api-key', { value: 'sk-ant-xyz' })
    const list = await call(ctx, 'GET', '/api/secrets')
    expect(list._json.names).toContain('api-key')
    expect(JSON.stringify(list._json)).not.toContain('sk-ant-xyz')  // list never leaks values
    const rev = await call(ctx, 'GET', '/api/secrets/api-key')
    expect(rev._json.value).toBe('sk-ant-xyz')
    await call(ctx, 'DELETE', '/api/secrets/api-key')
    expect((await call(ctx, 'GET', '/api/secrets'))._json.names).not.toContain('api-key')
  })
  it('reveal of missing secret 404s', async () => {
    const res = await call(ctx, 'GET', '/api/secrets/nope')
    expect(res._status).toBe(404)
  })
  it('migrate moves rc keys', async () => {
    await writeFile(join(home, '.zshrc'), 'export ANTHROPIC_API_KEY="sk-ant-LEGACY"\n')
    const res = await call(ctx, 'POST', '/api/secrets/migrate')
    expect(res._json.migrated).toContain('anthropic-api-key')
    expect((await call(ctx, 'GET', '/api/secrets/anthropic-api-key'))._json.value).toBe('sk-ant-LEGACY')
  })
})
```

- [ ] **Step 4: Run to verify fail** → FAIL

- [ ] **Step 5: Implement** — add to `buildRoutes` (import `secretsStore` and `migrateRcSecrets` at top of api.ts: `import { secretsStore, migrateRcSecrets } from '../commands/secrets.js'`):

```ts
  add('GET', /^\/api\/secrets$/, async (_m, _req, res) => {
    const store = await secretsStore(ctx)
    sendJson(res, 200, { names: await store.list(), backend: store.backendName })
  })
  add('GET', /^\/api\/secrets\/([^/]+)$/, async (mtch, _req, res) => {
    const store = await secretsStore(ctx)
    const value = await store.get(decodeURIComponent(mtch[1]))
    if (value === null) throw new HttpError(404, 'not found')
    sendJson(res, 200, { value })
  })
  add('PUT', /^\/api\/secrets\/([^/]+)$/, async (mtch, req, res) => {
    const { value } = await readJson<{ value: string }>(req)
    if (typeof value !== 'string') throw new HttpError(400, 'value required')
    const store = await secretsStore(ctx)
    await store.set(decodeURIComponent(mtch[1]), value)
    sendJson(res, 200, { ok: true })
  })
  add('DELETE', /^\/api\/secrets\/([^/]+)$/, async (mtch, _req, res) => {
    const store = await secretsStore(ctx)
    await store.delete(decodeURIComponent(mtch[1]))
    sendJson(res, 200, { ok: true })
  })
  add('POST', /^\/api\/secrets\/migrate$/, async (_m, _req, res) => {
    sendJson(res, 200, { migrated: await migrateRcSecrets(ctx) })
  })
```

- [ ] **Step 6: Run to verify pass** → PASS
- [ ] **Step 7: Commit** — `git commit -am "feat(ui): api routes for secrets + extract migrateRcSecrets helper"`

---

### Task 6: Sync + devices handlers

**Files:**
- Modify: `packages/cli/src/ui/api.ts`
- Test: `packages/cli/test/ui-api-sync.test.ts`

**Interfaces:**
- Consumes: `loadDevices`, `fetchRemote`, `fetchSecrets`, `writeAssets`, `parseManifest`, `backupFiles` from core; `secretsStore`.
- Produces (added): `GET /api/devices`, `POST /api/sync`.
- `POST /api/sync` body `{ from: string; withSecrets?: boolean; dryRun?: boolean }` → `{ performed: string[]; secrets: string[] }`.

- [ ] **Step 1: Write failing test** (uses an in-process sync server as the peer)

`packages/cli/test/ui-api-sync.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { startSyncServer, parseManifest, serializeManifest } from 'ccprofiles-core'
import { makeContext } from '../src/context.js'
import { buildRoutes } from '../src/ui/api.js'
import { matchRoute } from '../src/ui/http.js'
import { saveDevices } from 'ccprofiles-core'

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket()); req.method = method; req.url = url
  process.nextTick(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  return req
}
function fakeRes(): any {
  const res: any = new ServerResponse(new IncomingMessage(new Socket())); let chunks = ''
  res.writeHead = (c: number) => { res._status = c; return res }
  res.end = (t?: string) => { if (t) { chunks += t; try { res._json = JSON.parse(chunks) } catch {} } return res }
  res.write = (t: string) => { chunks += t; return true }
  return res
}
async function call(ctx: any, method: string, path: string, body?: unknown) {
  const m = matchRoute(buildRoutes(ctx), method, path)
  if (!m) throw new Error(`no route ${method} ${path}`)
  const res = fakeRes(); await m.route.handler(m.match, fakeReq(method, path, body), res); return res
}

let peerHome: string, myHome: string, server: any
beforeEach(async () => {
  // peer with a manifest to serve
  peerHome = await mkdtemp(join(tmpdir(), 'ccp-peer-'))
  await mkdir(join(peerHome, '.claude', 'skills'), { recursive: true })
  await writeFile(join(peerHome, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  const peerCtx = makeContext({ CCPROFILES_TEST_HOME: peerHome, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await call(peerCtx, 'POST', '/api/adopt')
  const mp = join(peerCtx.manifestRoot, 'manifest.yaml')
  const m = parseManifest(await readFile(mp, 'utf8')); m.hub = 'default'; await writeFile(mp, serializeManifest(m))
  const p = peerCtx.platform
  server = await startSyncServer({ manifestRoot: peerCtx.manifestRoot, platform: p, pin: '111222' })

  // my machine, already "paired" (inject the device record directly)
  myHome = await mkdtemp(join(tmpdir(), 'ccp-me-'))
  const myCtx = makeContext({ CCPROFILES_TEST_HOME: myHome, CCPROFILES_PASSPHRASE: 'pw2', SHELL: '/bin/zsh' } as any)
  // pair via the real client to get a valid token+key
  const { pairWithServer } = await import('ccprofiles-core')
  const device = await pairWithServer('127.0.0.1', server.port, '111222', 'peer')
  await saveDevices(myCtx.manifestRoot, [device])
  ;(globalThis as any).__myCtx = myCtx
})
afterEach(async () => { await server.close() })

describe('ui api: sync', () => {
  it('lists devices and pulls a manifest', async () => {
    const ctx = (globalThis as any).__myCtx
    expect((await call(ctx, 'GET', '/api/devices'))._json.map((d: any) => d.name)).toContain('peer')
    const res = await call(ctx, 'POST', '/api/sync', { from: 'peer' })
    expect(res._json.performed.join('\n')).toMatch(/set mcpServers/)
    expect(existsSync(join(myHome, '.claude.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL

- [ ] **Step 3: Implement** — add to `buildRoutes` (add imports `loadDevices, fetchRemote, fetchSecrets, writeAssets, parseManifest, backupFiles` from `ccprofiles-core`):

```ts
  add('GET', /^\/api\/devices$/, async (_m, _req, res) => {
    sendJson(res, 200, await loadDevices(ctx.manifestRoot))
  })

  add('POST', /^\/api\/sync$/, async (_m, req, res) => {
    const { from, withSecrets, dryRun } = await readJson<{ from: string; withSecrets?: boolean; dryRun?: boolean }>(req)
    const device = (await loadDevices(ctx.manifestRoot)).find(d => d.name === from)
    if (!device) throw new HttpError(400, `unknown device: ${from}`)
    const { manifestYaml, assets } = await fetchRemote(device)
    const m = parseManifest(manifestYaml)
    if (!dryRun) {
      await backupFiles([join(ctx.manifestRoot, 'manifest.yaml')], ctx.backupRoot, stamp())
      await saveManifest(ctx.manifestRoot, m)
      await writeAssets(assets, m, ctx.platform)
    }
    const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!dryRun })
    let secrets: string[] = []
    if (withSecrets) {
      const values = await fetchSecrets(device, [])
      if (!dryRun) { const store = await secretsStore(ctx); for (const [k, v] of Object.entries(values)) await store.set(k, v) }
      secrets = Object.keys(values)
    }
    sendJson(res, 200, { performed: r.performed, secrets })
  })
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): api routes for devices + sync"`

---

### Task 7: UI server (token guard + api + static)

**Files:**
- Create: `packages/cli/src/ui/static.ts`, `packages/cli/src/ui/server.ts`
- Test: `packages/cli/test/ui-server.test.ts`

**Interfaces:**
- Consumes: `buildRoutes` (api.ts), `matchRoute`, `sendJson`, `HttpError` (http.ts), `tokenOk`, `originOk` (token.ts), `CliContext`.
- Produces:
  - `serveStatic(res, urlPath, uiDir): void` — serves files under `uiDir`; unknown path → `index.html`; sets content-type by extension; 404 `index.html` missing → plain "UI not built".
  - `startUiServer(ctx: CliContext, opts: { port?: number; token: string; uiDir: string }): Promise<{ port: number; close(): Promise<void> }>` — binds `127.0.0.1`; for `/api/*` enforces `originOk` (else 403) then `tokenOk` from `x-ccp-token` (else 401), routes via `buildRoutes`, maps thrown `HttpError`→status, other throw→500 (generic body, detail to stderr); non-`/api` → `serveStatic`.

- [ ] **Step 1: Write failing test** (drive the real server over a socket)

`packages/cli/test/ui-server.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { startUiServer } from '../src/ui/server.js'
import { newUiToken } from '../src/ui/token.js'

let home: string, uiDir: string, token: string, srv: Awaited<ReturnType<typeof startUiServer>>, base: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uisrv-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  uiDir = await mkdtemp(join(tmpdir(), 'ccp-uidir-'))
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>ccprofiles</title>')
  token = newUiToken()
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  srv = await startUiServer(ctx, { token, uiDir })
  base = `http://127.0.0.1:${srv.port}`
})
afterEach(async () => { await srv.close() })

describe('ui server', () => {
  it('serves index.html at /', async () => {
    const r = await fetch(base + '/')
    expect(await r.text()).toContain('ccprofiles')
  })
  it('serves index.html for unknown SPA route', async () => {
    const r = await fetch(base + '/profiles')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('ccprofiles')
  })
  it('401s /api without token', async () => {
    const r = await fetch(base + '/api/profiles')
    expect(r.status).toBe(401)
  })
  it('serves /api with token', async () => {
    const r = await fetch(base + '/api/profiles', { headers: { 'x-ccp-token': token } })
    expect(r.status).toBe(200)
    expect(Array.isArray(await r.json())).toBe(true)
  })
  it('403s /api with a foreign Origin', async () => {
    const r = await fetch(base + '/api/profiles', { headers: { 'x-ccp-token': token, origin: 'http://evil.com' } })
    expect(r.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL

- [ ] **Step 3: Implement**

`packages/cli/src/ui/static.ts`:
```ts
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import type { ServerResponse } from 'node:http'

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
}

export function serveStatic(res: ServerResponse, urlPath: string, uiDir: string): void {
  const index = join(uiDir, 'index.html')
  // strip query, prevent path traversal
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let file = join(uiDir, clean)
  if (!file.startsWith(uiDir) || !existsSync(file) || statSync(file).isDirectory()) file = index
  if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('UI not built'); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}
```

`packages/cli/src/ui/server.ts`:
```ts
import { createServer } from 'node:http'
import type { CliContext } from '../context.js'
import { buildRoutes } from './api.js'
import { matchRoute, sendJson, HttpError } from './http.js'
import { tokenOk, originOk } from './token.js'
import { serveStatic } from './static.js'

export async function startUiServer(
  ctx: CliContext,
  opts: { port?: number; token: string; uiDir: string },
): Promise<{ port: number; close: () => Promise<void> }> {
  const routes = buildRoutes(ctx)

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    if (!path.startsWith('/api/')) return serveStatic(res, url, opts.uiDir)

    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    if (!originOk(req.headers.origin, port)) return sendJson(res, 403, { error: 'bad origin' })
    if (!tokenOk(req.headers['x-ccp-token'] as string | undefined, opts.token)) return sendJson(res, 401, { error: 'unauthorized' })

    const m = matchRoute(routes, req.method ?? 'GET', path)
    if (!m) return sendJson(res, 404, { error: 'not found' })
    try {
      await m.route.handler(m.match, req, res)
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message })
      process.stderr.write(`ui api error: ${(e as Error).stack ?? e}\n`)
      return sendJson(res, 500, { error: 'internal error' })
    }
  })

  await new Promise<void>(resolve => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))) }
}
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): localhost ui server with token+origin guard and static serving"`

---

### Task 8: `clp ui` command

**Files:**
- Create: `packages/cli/src/ui/command.ts`
- Modify: `packages/cli/src/context.ts` (register)
- Test: `packages/cli/test/ui-command.test.ts`

**Interfaces:**
- Consumes: `startUiServer`, `newUiToken`, `CliContext`.
- Produces: `registerUiCommand(program: Command, ctx: CliContext): void` → `clp ui [--port <n>] [--no-open]`. Resolves the built UI dir as `<dirname(cli dist)>/ui` (i.e. `packages/cli/dist/ui` after build). If that dir has no `index.html`, prints a hint to run `npm run build`. Opens the browser to `http://127.0.0.1:<port>/?t=<token>` unless `--no-open` (uses `open`/`xdg-open`/`start` per platform via `child_process`; failure to open is non-fatal). Keeps running until Ctrl-C.
- Test asserts the command starts a server and prints a URL containing the token; uses `--no-open` and a fake `uiDir` override via env `CCPROFILES_UI_DIR` (add support for that env in command.ts for testability).

- [ ] **Step 1: Write failing test**

`packages/cli/test/ui-command.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string, uiDir: string, logs: string[], spy: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uicmd-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  uiDir = await mkdtemp(join(tmpdir(), 'ccp-uicmddir-'))
  await writeFile(join(uiDir, 'index.html'), '<!doctype html>')
  logs = []
  spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
})
afterEach(() => spy.mockRestore())

describe('clp ui', () => {
  it('starts a server and prints a tokened localhost url', async () => {
    const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_UI_DIR: uiDir, SHELL: '/bin/zsh' } as any)
    // resolve after the server is up: command.ts calls opts.onListening in tests
    const program = buildProgram(ctx)
    const started = new Promise<void>(resolve => { (globalThis as any).__uiOnListening = resolve })
    await Promise.race([
      program.parseAsync(['node', 'ccp', 'ui', '--no-open', '--port', '0']),
      started,
    ])
    const url = logs.find(l => l.includes('127.0.0.1'))
    expect(url).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)
    await (globalThis as any).__uiServerClose?.()
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL

- [ ] **Step 3: Implement**

`packages/cli/src/ui/command.ts`:
```ts
import type { Command } from 'commander'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { CliContext } from '../context.js'
import { startUiServer } from './server.js'
import { newUiToken } from './token.js'

function defaultUiDir(): string {
  // command.ts compiles to dist/ui/command.js → built assets at dist/ui/ (same dir's parent + /ui)
  const here = dirname(fileURLToPath(import.meta.url)) // .../dist/ui
  return join(dirname(here), 'ui')                     // .../dist/ui  (assets copied here at build)
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref() } catch { /* non-fatal */ }
}

export function registerUiCommand(program: Command, ctx: CliContext): void {
  program.command('ui').description('open the web dashboard (localhost)')
    .option('--port <n>', 'port (default: random)', v => parseInt(v, 10))
    .option('--no-open', 'do not open the browser automatically')
    .action(async (opts: { port?: number; open?: boolean }) => {
      const uiDir = ctx.env.CCPROFILES_UI_DIR ?? defaultUiDir()
      if (!existsSync(join(uiDir, 'index.html'))) {
        console.log(`dashboard assets not found at ${uiDir} — build first: npm run build`)
        return
      }
      const token = newUiToken()
      const srv = await startUiServer(ctx, { port: opts.port, token, uiDir })
      const url = `http://127.0.0.1:${srv.port}/?t=${token}`
      console.log(`ccprofiles dashboard: ${url}`)
      console.log('(localhost only · Ctrl-C to stop)')
      if (opts.open !== false) openBrowser(url)
      // test hooks
      ;(globalThis as any).__uiServerClose = srv.close
      ;(globalThis as any).__uiOnListening?.()
      if (!ctx.env.CCPROFILES_UI_DIR) await new Promise(() => {}) // run forever in real use
    })
}
```

In `context.ts`, import and register: `import { registerUiCommand } from './ui/command.js'` and call `registerUiCommand(program, ctx)` in `buildProgram`.

Note: the `run forever` guard is skipped when `CCPROFILES_UI_DIR` is set (tests), so the action resolves and the test can close the server. In production that env is unset, so it blocks until Ctrl-C.

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): clp ui command (localhost server + browser open)"`

---

### Task 9: Vite + React + Tailwind scaffold for `packages/ui`

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/vite.config.ts`, `packages/ui/tsconfig.json`, `packages/ui/index.html`, `packages/ui/src/main.tsx`, `packages/ui/src/index.css`, `packages/ui/tailwind.config.js`, `packages/ui/postcss.config.js`, `packages/ui/components.json`
- Modify: root `package.json` (add `ui` to workspaces already covered by `packages/*`)

**Interfaces:**
- Produces: a buildable empty SPA. `npm run build -w packages/ui` emits `packages/ui/dist/index.html` + assets with **relative** asset paths (`base: './'`) so it can be served from any path.

- [ ] **Step 1: Create scaffold files**

`packages/ui/package.json`:
```json
{
  "name": "@ccprofiles/ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "build": "vite build", "dev": "vite" },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.0",
    "lucide-react": "^0.454.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.6.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

`packages/ui/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true },
})
```

`packages/ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "Bundler", "jsx": "react-jsx", "strict": true, "skipLibCheck": true,
    "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, "noEmit": true
  },
  "include": ["src"]
}
```

`packages/ui/index.html`:
```html
<!doctype html>
<html lang="en" class="dark">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>ccprofiles</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`packages/ui/tailwind.config.js`:
```js
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

`packages/ui/postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`packages/ui/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
:root { color-scheme: light dark; }
body { @apply bg-background text-foreground; }
```

`packages/ui/src/main.tsx`:
```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

function App() { return <div className="p-8 text-2xl font-semibold">ccprofiles dashboard</div> }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
```

`packages/ui/components.json` (shadcn config, for the MCP tool to place components):
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "tailwind.config.js", "css": "src/index.css", "baseColor": "zinc", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils" }
}
```

- [ ] **Step 2: Install and build**

Run: `npm install && npm run build -w packages/ui`
Expected: creates `packages/ui/dist/index.html` and `packages/ui/dist/assets/*.js`

- [ ] **Step 3: Verify build output exists**

Run: `ls packages/ui/dist && grep -q 'ccprofiles' packages/ui/dist/index.html && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(ui): vite+react+tailwind scaffold for packages/ui"`

---

### Task 10: shadcn/ui base setup + API client + app shell

**Files:**
- Create: `packages/ui/src/lib/utils.ts`, `packages/ui/src/lib/api.ts`, `packages/ui/src/App.tsx`, `packages/ui/src/components/ui/*` (via shadcn MCP: button, card, table, dialog, input, label, badge, tabs, switch, sonner/toast)
- Modify: `packages/ui/src/main.tsx`, `packages/ui/src/index.css` (shadcn CSS variables)

**Interfaces:**
- Produces:
  - `cn(...)` util (shadcn standard).
  - `api` client in `src/lib/api.ts`:
    ```ts
    const token = new URLSearchParams(location.search).get('t') ?? ''
    async function req(method: string, path: string, body?: unknown): Promise<any>
    export const api = {
      profiles: () => req('GET', '/api/profiles'),
      adopt: () => req('POST', '/api/adopt'),
      createProfile: (name: string, from?: string) => req('POST', '/api/profiles', { name, from }),
      patchProfile: (name: string, patch: object) => req('PATCH', `/api/profiles/${name}`, patch),
      mcp: () => req('GET', '/api/mcp'),
      addMcp: (b: object) => req('POST', '/api/mcp', b),
      rmMcp: (name: string, targets: unknown) => req('DELETE', `/api/mcp/${name}`, { targets }),
      syncMcp: (from: string, to: unknown) => req('POST', '/api/mcp/sync', { from, to }),
      secrets: () => req('GET', '/api/secrets'),
      revealSecret: (n: string) => req('GET', `/api/secrets/${encodeURIComponent(n)}`),
      setSecret: (n: string, value: string) => req('PUT', `/api/secrets/${encodeURIComponent(n)}`, { value }),
      rmSecret: (n: string) => req('DELETE', `/api/secrets/${encodeURIComponent(n)}`),
      migrate: () => req('POST', '/api/secrets/migrate'),
      status: () => req('GET', '/api/status'),
      apply: () => req('POST', '/api/apply'),
      doctor: () => req('GET', '/api/doctor'),
      devices: () => req('GET', '/api/devices'),
      sync: (from: string, withSecrets: boolean) => req('POST', '/api/sync', { from, withSecrets }),
    }
    ```
    `req` sends `X-CCP-Token: token`, throws `Error(body.error)` on non-2xx.
  - `App.tsx`: sidebar shell with nav state (`profiles|mcp|secrets|sync|doctor|status`), renders the active page component (pages are stubs here, filled in Tasks 11–13). Uses shadcn `Card`, sonner `<Toaster/>`.

- [ ] **Step 1: Add shadcn components** — use the shadcn MCP (`mcp__shadcn__*`) to fetch and place: `button card table dialog input label badge tabs switch sonner`. Place under `src/components/ui/`. Update `src/index.css` with the shadcn zinc CSS variables block (`:root` + `.dark`), and `src/lib/utils.ts` with the standard `cn`.

- [ ] **Step 2: Write the api client** — create `src/lib/api.ts` exactly as in Interfaces.

- [ ] **Step 3: Write App shell** — `src/App.tsx` with a left sidebar (nav buttons) and a content area switching on active tab; import and render `<Toaster />`. Wire `main.tsx` to render `<App/>`.

`src/App.tsx` (shell; page components imported from Tasks 11–13, create empty placeholders now so it compiles):
```tsx
import { useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { ProfilesPage } from '@/pages/ProfilesPage'
import { McpPage } from '@/pages/McpPage'
import { SecretsPage } from '@/pages/SecretsPage'
import { SyncPage } from '@/pages/SyncPage'
import { DoctorPage } from '@/pages/DoctorPage'
import { StatusPage } from '@/pages/StatusPage'
import { cn } from '@/lib/utils'

const TABS = [
  ['status', 'Status'], ['profiles', 'Profiles'], ['mcp', 'MCP'],
  ['secrets', 'Secrets'], ['sync', 'Sync'], ['doctor', 'Doctor'],
] as const
type Tab = typeof TABS[number][0]

export default function App() {
  const [tab, setTab] = useState<Tab>('status')
  return (
    <div className="flex h-screen">
      <aside className="w-48 border-r p-3 space-y-1">
        <div className="px-2 pb-3 text-lg font-semibold">ccprofiles</div>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id as Tab)}
            className={cn('w-full text-left px-3 py-2 rounded-md text-sm', tab === id ? 'bg-accent' : 'hover:bg-accent/50')}>
            {label}
          </button>
        ))}
      </aside>
      <main className="flex-1 overflow-auto p-6">
        {tab === 'status' && <StatusPage />}
        {tab === 'profiles' && <ProfilesPage />}
        {tab === 'mcp' && <McpPage />}
        {tab === 'secrets' && <SecretsPage />}
        {tab === 'sync' && <SyncPage />}
        {tab === 'doctor' && <DoctorPage />}
      </main>
      <Toaster />
    </div>
  )
}
```
Create placeholder pages `src/pages/{Status,Profiles,Mcp,Secrets,Sync,Doctor}Page.tsx` each `export function XPage(){ return <div/> }` so the build passes now; filled next.

- [ ] **Step 4: Build to verify it compiles** — `npm run build -w packages/ui` → dist emitted, no TS errors.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): shadcn base, api client, app shell"`

---

### Task 11: Status + Profiles pages

**Files:**
- Modify: `packages/ui/src/pages/StatusPage.tsx`, `packages/ui/src/pages/ProfilesPage.tsx`

**Interfaces:**
- Consumes: `api` (lib/api.ts), shadcn `Card`, `Table`, `Button`, `Dialog`, `Input`, `Label`, sonner `toast`.
- Produces:
  - `StatusPage`: on mount `api.status()`; shows "In sync ✓" or a list of pending actions + an "Apply" button (`api.apply()` → toast performed count + backup dir, then re-fetch). Handles the "no manifest yet" 409 by showing an "Adopt profiles" button (`api.adopt()` then refetch).
  - `ProfilesPage`: `api.profiles()` → table; "Create profile" opens a Dialog (name input + "copy from" select of existing names) → `api.createProfile` → toast + refetch. Each row has an "Edit" button opening a drawer/dialog with env key/value rows and a launcher field → `api.patchProfile`.

- [ ] **Step 1: Implement StatusPage** (full component)

```tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { api } from '@/lib/api'

export function StatusPage() {
  const [state, setState] = useState<{ inSync: boolean; pending: string[] } | null>(null)
  const [needsAdopt, setNeedsAdopt] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setState(await api.status()); setNeedsAdopt(false) }
    catch (e: any) { if (String(e.message).includes('no manifest')) setNeedsAdopt(true); else toast.error(e.message) }
  }
  useEffect(() => { load() }, [])
  if (needsAdopt) return (
    <Card className="p-6 space-y-4">
      <div className="text-lg font-medium">No manifest yet</div>
      <p className="text-sm text-muted-foreground">Adopt your existing Claude profiles to get started.</p>
      <Button onClick={async () => { await api.adopt(); toast.success('Adopted'); load() }}>Adopt profiles</Button>
    </Card>
  )
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Status</h1>
      {state?.inSync
        ? <Card className="p-6 text-green-600">In sync ✓</Card>
        : <Card className="p-6 space-y-3">
            <div className="font-medium">Pending changes</div>
            <ul className="text-sm list-disc pl-5 space-y-1">{state?.pending.map((p, i) => <li key={i}>{p}</li>)}</ul>
            <Button disabled={busy} onClick={async () => {
              setBusy(true)
              try { const r = await api.apply(); toast.success(`Applied ${r.performed.length} change(s)`) ; await load() }
              catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
            }}>Apply</Button>
          </Card>}
    </div>
  )
}
```

- [ ] **Step 2: Implement ProfilesPage** (full component)

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api } from '@/lib/api'

type Row = { name: string; dir: string; auth: string; account: string | null; mcp: number; launcher: string | null; adopted: boolean }

export function ProfilesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState(''); const [from, setFrom] = useState(''); const [open, setOpen] = useState(false)
  const load = async () => { try { setRows(await api.profiles()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Profiles</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Create profile</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New profile</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="work" /></div>
              <div><Label>Copy MCP/links from (optional)</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background" value={from} onChange={e => setFrom(e.target.value)}>
                  <option value="">— none —</option>
                  {rows.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={async () => {
                try { await api.createProfile(name, from || undefined); toast.success(`Created ${name}`); setOpen(false); setName(''); setFrom(''); load() }
                catch (e: any) { toast.error(e.message) }
              }}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Auth</TableHead><TableHead>Account</TableHead><TableHead>MCP</TableHead><TableHead>Launcher</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.name}>
              <TableCell className="font-medium">{r.name}{!r.adopted && <span className="text-muted-foreground"> *</span>}</TableCell>
              <TableCell>{r.auth}</TableCell><TableCell>{r.account ?? '—'}</TableCell>
              <TableCell>{r.mcp}</TableCell><TableCell>{r.launcher ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
```
(Profile edit drawer is folded in here as a follow-up control; the create + list flow is the testable deliverable. Env editing reuses the same Dialog pattern and `api.patchProfile`.)

- [ ] **Step 3: Build to verify compile** — `npm run build -w packages/ui` → OK
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(ui): status and profiles pages"`

---

### Task 12: MCP + Secrets pages

**Files:**
- Modify: `packages/ui/src/pages/McpPage.tsx`, `packages/ui/src/pages/SecretsPage.tsx`

**Interfaces:**
- Consumes: `api`, shadcn `Table`, `Switch`, `Button`, `Dialog`, `Input`, `Label`, `Badge`, sonner `toast`.
- Produces:
  - `McpPage`: `api.mcp()` → matrix; header row = profile names; each cell a `Switch` reflecting membership. Toggling on a server not-yet-defined for a profile requires the server already defined (it is, since it's a column that exists) → calls `api.addMcp({name, targets:[profile]})` or `api.rmMcp(name, [profile])`, then refetch. "Add server" Dialog (name/command/args/targets=all). "Sync" control (from-select + to=all button → `api.syncMcp`).
  - `SecretsPage`: `api.secrets()` → list of names + backend badge. Each row: a reveal toggle that calls `api.revealSecret` and shows the value inline (hidden again on toggle), and a delete button. "Add secret" Dialog (name+value → `api.setSecret`). "Migrate from rc" button → `api.migrate()` → toast migrated names + refetch.

- [ ] **Step 1: Implement McpPage** (full component)

```tsx
import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api } from '@/lib/api'

type Mcp = { servers: string[]; profiles: { name: string; has: string[] }[] }

export function McpPage() {
  const [data, setData] = useState<Mcp | null>(null)
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', command: 'npx', args: '' })
  const [from, setFrom] = useState('')
  const load = async () => { try { setData(await api.mcp()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  if (!data) return null
  const toggle = async (server: string, profile: string, on: boolean) => {
    try { on ? await api.addMcp({ name: server, targets: [profile] }) : await api.rmMcp(server, [profile]); await load() }
    catch (e: any) { toast.error(e.message) }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">MCP servers</h1>
        <div className="flex gap-2 items-center">
          <select className="border rounded-md h-9 px-2 bg-background text-sm" value={from} onChange={e => setFrom(e.target.value)}>
            <option value="">sync from…</option>
            {data.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <Button variant="secondary" disabled={!from} onClick={async () => {
            try { await api.syncMcp(from, 'all'); toast.success(`Synced from ${from}`); await load() } catch (e: any) { toast.error(e.message) }
          }}>Sync → all</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add server</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add MCP server</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>Name</Label><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
                <div><Label>Command</Label><Input value={f.command} onChange={e => setF({ ...f, command: e.target.value })} /></div>
                <div><Label>Args (comma-separated)</Label><Input value={f.args} onChange={e => setF({ ...f, args: e.target.value })} placeholder="-y,@playwright/mcp@latest" /></div>
              </div>
              <DialogFooter><Button onClick={async () => {
                try { await api.addMcp({ name: f.name, command: f.command, args: f.args ? f.args.split(',') : [], targets: 'all' }); toast.success(`Added ${f.name}`); setOpen(false); setF({ name: '', command: 'npx', args: '' }); await load() }
                catch (e: any) { toast.error(e.message) }
              }}>Add to all</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead><tr><th className="text-left p-2">Server</th>{data.profiles.map(p => <th key={p.name} className="p-2 text-center">{p.name}</th>)}</tr></thead>
          <tbody>
            {data.servers.map(s => (
              <tr key={s} className="border-t">
                <td className="p-2 font-medium">{s}</td>
                {data.profiles.map(p => (
                  <td key={p.name} className="p-2 text-center">
                    <Switch checked={p.has.includes(s)} onCheckedChange={on => toggle(s, p.name, on)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Implement SecretsPage** (full component)

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api } from '@/lib/api'

export function SecretsPage() {
  const [names, setNames] = useState<string[]>([]); const [backend, setBackend] = useState('')
  const [shown, setShown] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false); const [f, setF] = useState({ name: '', value: '' })
  const load = async () => { try { const r = await api.secrets(); setNames(r.names); setBackend(r.backend) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  const reveal = async (n: string) => {
    if (shown[n] !== undefined) { const c = { ...shown }; delete c[n]; setShown(c); return }
    try { const r = await api.revealSecret(n); setShown({ ...shown, [n]: r.value }) } catch (e: any) { toast.error(e.message) }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Secrets <Badge variant="secondary">{backend}</Badge></h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={async () => { const r = await api.migrate(); toast.success(r.migrated.length ? `Migrated ${r.migrated.join(', ')}` : 'No plaintext keys found'); load() }}>Migrate from rc</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add secret</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add secret</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>Name</Label><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="anthropic-api-key" /></div>
                <div><Label>Value</Label><Input type="password" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} /></div>
              </div>
              <DialogFooter><Button onClick={async () => {
                try { await api.setSecret(f.name, f.value); toast.success(`Stored ${f.name}`); setOpen(false); setF({ name: '', value: '' }); load() } catch (e: any) { toast.error(e.message) }
              }}>Save</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="divide-y border rounded-md">
        {names.map(n => (
          <div key={n} className="flex items-center justify-between p-3">
            <div className="font-mono text-sm">{n}{shown[n] !== undefined && <span className="ml-3 text-muted-foreground">{shown[n]}</span>}</div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => reveal(n)}>{shown[n] !== undefined ? 'Hide' : 'Reveal'}</Button>
              <Button size="sm" variant="ghost" onClick={async () => { await api.rmSecret(n); toast.success(`Removed ${n}`); load() }}>Delete</Button>
            </div>
          </div>
        ))}
        {names.length === 0 && <div className="p-3 text-sm text-muted-foreground">No secrets yet.</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Build to verify compile** — `npm run build -w packages/ui` → OK
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(ui): mcp matrix and secrets pages"`

---

### Task 13: Sync + Doctor pages

**Files:**
- Modify: `packages/ui/src/pages/SyncPage.tsx`, `packages/ui/src/pages/DoctorPage.tsx`

**Interfaces:**
- Consumes: `api`, shadcn `Card`, `Button`, `Switch`, `Label`.
- Produces:
  - `SyncPage`: `api.devices()` → list; per device a "Pull" button + a "with secrets" switch → `api.sync(name, withSecrets)` → toast performed + secrets. Empty state points to `clp pair` (pairing is CLI-only in v1).
  - `DoctorPage`: `api.doctor()` → problem cards (or an all-clear card); "Re-run" button.

- [ ] **Step 1: Implement SyncPage** (full component)

```tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { api } from '@/lib/api'

type Device = { name: string; host: string; port: number }

export function SyncPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [withSecrets, setWithSecrets] = useState(false)
  const load = async () => { try { setDevices(await api.devices()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sync</h1>
        <div className="flex items-center gap-2"><Switch id="ws" checked={withSecrets} onCheckedChange={setWithSecrets} /><Label htmlFor="ws">with secrets</Label></div>
      </div>
      {devices.length === 0
        ? <Card className="p-6 text-sm text-muted-foreground">No paired devices. Pair one from the CLI: <code>clp pair &lt;host&gt; --port &lt;p&gt; --pin &lt;pin&gt;</code></Card>
        : devices.map(d => (
          <Card key={d.name} className="p-4 flex items-center justify-between">
            <div><div className="font-medium">{d.name}</div><div className="text-xs text-muted-foreground">{d.host}:{d.port}</div></div>
            <Button onClick={async () => {
              try { const r = await api.sync(d.name, withSecrets); toast.success(`Pulled ${r.performed.length} change(s)${r.secrets.length ? `, secrets: ${r.secrets.join(', ')}` : ''}`) }
              catch (e: any) { toast.error(e.message) }
            }}>Pull</Button>
          </Card>
        ))}
    </div>
  )
}
```

- [ ] **Step 2: Implement DoctorPage** (full component)

```tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { api } from '@/lib/api'

export function DoctorPage() {
  const [problems, setProblems] = useState<string[] | null>(null)
  const load = async () => { try { setProblems((await api.doctor()).problems) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Doctor</h1><Button variant="secondary" onClick={load}>Re-run</Button></div>
      {problems === null ? null : problems.length === 0
        ? <Card className="p-6 text-green-600">No problems found ✓</Card>
        : problems.map((p, i) => <Card key={i} className="p-4 text-sm">{p}</Card>)}
    </div>
  )
}
```

- [ ] **Step 3: Build to verify compile** — `npm run build -w packages/ui` → OK
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(ui): sync and doctor pages"`

---

### Task 14: Build integration — copy UI into CLI package + ship

**Files:**
- Create: `scripts/copy-ui.mjs`
- Modify: root `package.json` (scripts), `packages/cli/package.json` (`files`, version)

**Interfaces:**
- Produces: `npm run build` at the repo root builds core+cli (tsc) then the UI (vite) then copies `packages/ui/dist` → `packages/cli/dist/ui`. The published CLI tarball contains `dist/ui`.

- [ ] **Step 1: Write the copy script**

`scripts/copy-ui.mjs`:
```js
import { cp, rm, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'packages/ui/dist')
const dest = join(root, 'packages/cli/dist/ui')
try { await access(src) } catch { console.error('packages/ui/dist missing — run vite build first'); process.exit(1) }
await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
console.log(`copied UI → ${dest}`)
```

- [ ] **Step 2: Wire root scripts** — in root `package.json`:
```json
  "scripts": {
    "build": "tsc -b packages/core packages/cli && npm run build:ui && node scripts/copy-ui.mjs",
    "build:ui": "npm run build -w @ccprofiles/ui",
    "test": "vitest run"
  }
```

- [ ] **Step 3: Add `dist/ui` to the CLI package files + bump version** — in `packages/cli/package.json`: set `"version": "0.2.0"` and `"files": ["dist", "README.md"]` (already includes `dist`, so `dist/ui` ships automatically — confirm by packing).

- [ ] **Step 4: Full build + verify the asset landed in the CLI dist**

Run: `npm run build && ls packages/cli/dist/ui/index.html`
Expected: path prints (file exists)

- [ ] **Step 5: Verify it ships in the tarball**

Run: `cd packages/cli && npm pack --dry-run 2>&1 | grep -c "dist/ui/"`
Expected: a number ≥ 2 (index.html + at least one asset)

- [ ] **Step 6: Commit** — `git add -A && git commit -m "build(ui): copy UI into cli dist and ship in tarball; bump cli to 0.2.0"`

---

### Task 15: End-to-end Playwright smoke test

**Files:**
- Create: `packages/cli/test-e2e/ui.smoke.md` (a scripted checklist run via the Playwright MCP, not vitest — documented steps + expected DOM)

**Interfaces:** consumes the fully built app + `clp ui`.

- [ ] **Step 1: Build and launch against a sandbox home**

```bash
npm run build
SB=$(mktemp -d); mkdir -p $SB/.claude; echo '{"mcpServers":{"playwright":{"command":"npx"}}}' > $SB/.claude.json
CCPROFILES_TEST_HOME=$SB CCPROFILES_PASSPHRASE=pw SHELL=/bin/zsh \
  node packages/cli/dist/index.js ui --no-open --port 5599 &
# note the printed URL (contains ?t=<token>)
```

- [ ] **Step 2: Drive with Playwright MCP** — navigate to the printed `http://127.0.0.1:5599/?t=…`, then:
  - Status page shows "No manifest yet" → click "Adopt profiles" → status becomes pending or in-sync.
  - Profiles page lists `default`; open Create, add `work`, submit → row appears.
  - MCP page shows `playwright` row; toggle it on for `work` → switch stays on after reload.
  - Secrets page: Add `test-key`=`sk-ant-x`; Reveal shows `sk-ant-x`; Delete removes it.
  - Doctor page renders (all-clear or findings).
  Capture a screenshot of the Profiles page as evidence.

- [ ] **Step 3: Tear down** — kill the `clp ui` process, `rm -rf $SB`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "test(ui): playwright smoke checklist for the dashboard"`

---

## Self-Review Notes

- **Spec coverage:** `clp ui` command (T8) ✔; localhost+token+origin security (T2, T7) ✔; full API surface — adopt/profiles/status/apply/doctor (T3), mcp (T4), secrets+reveal+migrate (T5), devices/sync (T6) ✔; shadcn UI pages for every area (T10–13) ✔; build/ship into CLI tarball + 0.2.0 bump (T14) ✔; API unit tests + Playwright smoke (T3–7, T15) ✔; adopt-from-empty (T3 + StatusPage T11) ✔.
- **DRY refactor:** T5 extracts `migrateRcSecrets` so CLI and API share it (spec's "same functions the CLI uses").
- **Type consistency:** `buildRoutes(ctx)`, `CliContext`, `api.*` client method names, and JSON shapes (`{inSync,pending}`, `{servers,profiles:[{name,has}]}`, `{names,backend}`, `{value}`, `{problems}`, `{performed,backupDir}`) are used identically across API tasks and UI pages.
- **Known deferrals (spec Out-of-scope):** pairing from UI, websockets/auto-refresh, raw-YAML editing — not in any task, by design.
- **`ccprofiles-core` unchanged** — no core edits in this plan, so no core version bump (constraint honored).
