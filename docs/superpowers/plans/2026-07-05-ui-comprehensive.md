# Comprehensive UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `clp ui` a full management surface: edit/delete profiles, preview + update the rc managed block, and attach/detach secrets to profiles.

**Architecture:** Extend the existing route table in `packages/cli/src/ui/api.ts` (3 new routes, 1 extended) and the existing single-page React UI in `packages/ui` (profile editor dialog, new Shell RC tab, secrets usage badges). Manifest stays the single source of truth; every mutation saves the manifest then runs apply.

**Tech Stack:** Node 20+, TypeScript, vitest (cli/core packages), React + Vite + tailwind/shadcn-style components (ui package).

**Spec:** `docs/superpowers/specs/2026-07-05-ui-comprehensive-design.md`

## Global Constraints

- Run all commands from repo root: `~/Development/personal/ccprofiles`.
- Tests: `npx vitest run <file>` (root `vitest.config.ts` covers cli/core). Full build: `npm run build`.
- The UI package has no test runner — UI tasks are verified by `npm run build` succeeding plus the final sandboxed verify.
- Never touch content outside the rc `BEGIN_MARK`/`END_MARK` markers (guaranteed by `upsertManagedBlock`).
- Profile delete is manifest-only; never delete profile directories.
- Follow existing code style: 2-space indent, no semicolons in UI code where the file omits them, compact handlers in api.ts.
- Commit after each task with the message given in the task.

---

### Task 1: `GET /api/profiles` returns `env`, `links`, `mcpNames`

**Files:**
- Modify: `packages/cli/src/ui/api.ts:51-66` (the GET /api/profiles route)
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Produces: each profile row additionally has `env: Record<string,string>`, `links: Record<string,string>`, `mcpNames: string[]` (empty for unadopted profiles). Tasks 4–6 consume these fields in the UI.

- [ ] **Step 1: Write the failing test** — append inside the existing `describe('ui api: adopt/profiles/status/apply/doctor', ...)` block in `packages/cli/test/ui-api-core.test.ts`:

```ts
  it('profiles include env, links, and mcpNames from the manifest', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'PATCH', '/api/profiles/default', { env: { FOO: 'bar' } })
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.env).toEqual({ FOO: 'bar' })
    expect(row.mcpNames).toEqual(['playwright'])
    expect(row.links).toEqual({})
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts`
Expected: FAIL — `row.env` is `undefined`.

- [ ] **Step 3: Implement** — in `packages/cli/src/ui/api.ts`, inside the `GET /api/profiles` route, extend the returned row object:

```ts
      return {
        name, dir: lp.dir, auth: decl?.auth ?? (lp.account ? 'oauth' : 'env'),
        account: lp.account, mcp: Object.keys(lp.mcpServers).length,
        launcher: decl?.launcher ?? (name === 'default' ? null : `cl-${name}`),
        adopted: !!decl,
        env: decl?.env ?? {}, links: decl?.links ?? {}, mcpNames: decl?.mcp ?? [],
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/test/ui-api-core.test.ts
git commit -m "feat(ui-api): profiles rows include env, links, mcpNames"
```

---

### Task 2: `DELETE /api/profiles/:name`

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (add route directly after the PATCH /api/profiles route)
- Test: `packages/cli/test/ui-api-core.test.ts`

**Interfaces:**
- Produces: `DELETE /api/profiles/:name` → `{ ok: true }`; 404 unknown; 400 when the profile is the manifest hub. Task 4's `api.deleteProfile(name)` calls this.

- [ ] **Step 1: Write the failing tests** — in `packages/cli/test/ui-api-core.test.ts`. First extend the fs/promises import at the top of the file:

```ts
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
```

(`existsSync` and `join` may already be imported — keep one import each.) Then append tests:

```ts
  it('DELETE removes profile from manifest and rc but keeps the dir', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/profiles', { name: 'work' })
    expect(await readFile(ctx.platform.rcFile, 'utf8')).toContain('cl-work')
    const del = await callApi(ctx, 'DELETE', '/api/profiles/work')
    expect(del._json.ok).toBe(true)
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'work')
    expect(row.adopted).toBe(false)
    expect(existsSync(join(home, '.claude-work'))).toBe(true)
    expect(await readFile(ctx.platform.rcFile, 'utf8')).not.toContain('cl-work')
  })
  it('DELETE unknown profile 404s', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    expect((await callApi(ctx, 'DELETE', '/api/profiles/nope'))._status).toBe(404)
  })
  it('DELETE the hub profile is rejected', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const mp = join(ctx.manifestRoot, 'manifest.yaml')
    const m = parseManifest(await readFile(mp, 'utf8'))
    m.hub = 'default'
    await writeFile(mp, serializeManifest(m))
    const res = await callApi(ctx, 'DELETE', '/api/profiles/default')
    expect(res._status).toBe(400)
    expect(res._json.error).toMatch(/hub/)
  })
```

Add to the top of the file: `import { parseManifest, serializeManifest } from 'ccprofiles-core'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts`
Expected: FAIL — `no route DELETE /api/profiles/work` (thrown by `callApi`).

- [ ] **Step 3: Implement** — in `packages/cli/src/ui/api.ts`, immediately after the `PATCH /api/profiles/:name` route:

```ts
  add('DELETE', /^\/api\/profiles\/([^/]+)$/, async (mtch, _req, res) => {
    const m = await mustManifest()
    const name = decodeURIComponent(mtch[1])
    const idx = m.profiles.findIndex(p => p.name === name)
    if (idx === -1) throw new HttpError(404, `unknown profile: ${name}`)
    if (m.hub === name) throw new HttpError(400, `profile "${name}" is the hub — change the hub first`)
    m.profiles.splice(idx, 1)
    for (const s of Object.keys(m.mcpServers))
      if (!m.profiles.some(p => p.mcp.includes(s))) delete m.mcpServers[s]
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/cli/test/ui-api-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/test/ui-api-core.test.ts
git commit -m "feat(ui-api): DELETE /api/profiles/:name (manifest-only, hub-guarded)"
```

---

### Task 3: rc endpoints — `GET /api/rc` and `POST /api/rc`

**Files:**
- Modify: `packages/cli/src/ui/api.ts` (imports + two routes, add a `── shell rc ──` section after the doctor route)
- Create: `packages/cli/test/ui-api-rc.test.ts`

**Interfaces:**
- Consumes: `renderRcBlock(m, platform)`, `upsertManagedBlock(content, block)`, `BEGIN_MARK`, `END_MARK`, `backupFiles(files, backupRoot, stamp)`, `atomicWrite(path, content)` — all exported from `ccprofiles-core`.
- Produces: `GET /api/rc` → `{ rcFile: string, current: string | null, rendered: string, inSync: boolean }`; `POST /api/rc` → `{ ok: true, backupDir: string | null }`. Task 4's `api.rc()` / `api.updateRc()` call these.

- [ ] **Step 1: Write the failing tests** — create `packages/cli/test/ui-api-rc.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uirc-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: rc', () => {
  it('GET reports missing block, POST writes it, GET reports in sync', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const before = (await callApi(ctx, 'GET', '/api/rc'))._json
    expect(before.rcFile).toBe(ctx.platform.rcFile)
    expect(before.current).toBeNull()
    expect(before.inSync).toBe(false)
    expect(before.rendered).toContain('# >>> ccprofiles managed >>>')

    const post = (await callApi(ctx, 'POST', '/api/rc'))._json
    expect(post.ok).toBe(true)

    const after = (await callApi(ctx, 'GET', '/api/rc'))._json
    expect(after.inSync).toBe(true)
    expect(after.current).toBe(after.rendered)
  })

  it('POST preserves content outside the managed block and backs up the rc file', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await writeFile(ctx.platform.rcFile, '# my stuff\nalias ll="ls -l"\n')
    const res = (await callApi(ctx, 'POST', '/api/rc'))._json
    expect(res.backupDir).toBeTruthy()
    const rc = await readFile(ctx.platform.rcFile, 'utf8')
    expect(rc).toContain('alias ll')
    expect(rc).toContain('# >>> ccprofiles managed >>>')
    const backup = await readFile(join(res.backupDir, (ctx.platform.rcFile as string).replace(/:/g, '').replace(/[\\/]+/g, '__').replace(/^__/, '')), 'utf8')
    expect(backup).toBe('# my stuff\nalias ll="ls -l"\n')
  })

  it('GET without a manifest 409s', async () => {
    const res = await callApi(ctx, 'GET', '/api/rc')
    expect(res._status).toBe(409)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/ui-api-rc.test.ts`
Expected: FAIL — `no route GET /api/rc`.

- [ ] **Step 3: Implement** — in `packages/cli/src/ui/api.ts`:

Extend the `ccprofiles-core` import to add the rc helpers:

```ts
import {
  discoverProfiles, buildManifest, saveManifest, planApply, executeApply,
  ensureRootGitignore, loadManifest, loadDevices, fetchRemote, fetchSecrets,
  writeAssets, parseManifest, backupFiles, renderRcBlock, upsertManagedBlock,
  atomicWrite, BEGIN_MARK, END_MARK, type Manifest,
} from 'ccprofiles-core'
```

Add after the doctor route (before the `── mcp ──` section):

```ts
  // ── shell rc ────────────────────────────────────────────────────────────────
  function currentRcBlock(): string | null {
    if (!existsSync(ctx.platform.rcFile)) return null
    const rc = readFileSync(ctx.platform.rcFile, 'utf8')
    const start = rc.indexOf(BEGIN_MARK)
    const end = rc.indexOf(END_MARK)
    if (start === -1 || end === -1 || end < start) return null
    return rc.slice(start, end + END_MARK.length)
  }

  add('GET', /^\/api\/rc$/, async (_m, _req, res) => {
    const m = await mustManifest()
    const rendered = renderRcBlock(m, ctx.platform)
    const current = currentRcBlock()
    sendJson(res, 200, { rcFile: ctx.platform.rcFile, current, rendered, inSync: current === rendered })
  })

  add('POST', /^\/api\/rc$/, async (_m, _req, res) => {
    const m = await mustManifest()
    const rendered = renderRcBlock(m, ctx.platform)
    let rc = ''
    let backupDir: string | null = null
    if (existsSync(ctx.platform.rcFile)) {
      rc = readFileSync(ctx.platform.rcFile, 'utf8')
      backupDir = await backupFiles([ctx.platform.rcFile], ctx.backupRoot, stamp())
    }
    await atomicWrite(ctx.platform.rcFile, upsertManagedBlock(rc, rendered))
    sendJson(res, 200, { ok: true, backupDir })
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/cli/test/ui-api-rc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/api.ts packages/cli/test/ui-api-rc.test.ts
git commit -m "feat(ui-api): GET/POST /api/rc — managed block preview and one-click update"
```

---

### Task 4: UI — api client additions, profile editor, delete

**Files:**
- Modify: `packages/ui/src/lib/api.ts`
- Create: `packages/ui/src/components/ProfileEditor.tsx`
- Modify: `packages/ui/src/pages/ProfilesPage.tsx`

**Interfaces:**
- Consumes: Task 1 row fields (`env`, `links`, `mcpNames`), Task 2 DELETE route, existing `PATCH /api/profiles/:name`, `GET /api/mcp`, `GET /api/secrets`, `POST /api/mcp`, `DELETE /api/mcp/:name`.
- Produces: `ProfileRow` type and `api.deleteProfile/rc/updateRc` used by Tasks 5–6.

- [ ] **Step 1: Extend the UI api client** — in `packages/ui/src/lib/api.ts`, add to the `api` object after `patchProfile`:

```ts
  deleteProfile: (name: string) => req('DELETE', `/api/profiles/${encodeURIComponent(name)}`),
  rc: () => req('GET', '/api/rc'),
  updateRc: () => req('POST', '/api/rc'),
```

- [ ] **Step 2: Create the editor component** — `packages/ui/src/components/ProfileEditor.tsx`:

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
}

const SECRET_PREFIX = 'secret://'
type EnvRow = { key: string; value: string; secret: boolean }
type KvRow = { key: string; value: string }

function toEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => value.startsWith(SECRET_PREFIX)
    ? { key, value: value.slice(SECRET_PREFIX.length), secret: true }
    : { key, value, secret: false })
}

export function ProfileEditor({ profile, servers, secretNames, onClose, onSaved }: {
  profile: ProfileRow; servers: string[]; secretNames: string[]
  onClose: () => void; onSaved: () => void
}) {
  const [launcher, setLauncher] = useState(profile.launcher ?? '')
  const [env, setEnv] = useState<EnvRow[]>(toEnvRows(profile.env))
  const [links, setLinks] = useState<KvRow[]>(Object.entries(profile.links).map(([key, value]) => ({ key, value })))
  const [mcp, setMcp] = useState<string[]>(profile.mcpNames)
  const [saving, setSaving] = useState(false)

  const setEnvAt = (i: number, patch: Partial<EnvRow>) => setEnv(env.map((r, j) => j === i ? { ...r, ...patch } : r))
  const setLinkAt = (i: number, patch: Partial<KvRow>) => setLinks(links.map((r, j) => j === i ? { ...r, ...patch } : r))

  const save = async () => {
    setSaving(true)
    try {
      const envObj: Record<string, string> = {}
      for (const r of env) if (r.key.trim()) envObj[r.key.trim()] = r.secret ? SECRET_PREFIX + r.value : r.value
      const linksObj: Record<string, string> = {}
      for (const r of links) if (r.key.trim()) linksObj[r.key.trim()] = r.value
      await api.patchProfile(profile.name, { env: envObj, links: linksObj, launcher: launcher.trim() || null })
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
            <Label>Environment variables</Label>
            {env.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="w-56 font-mono text-xs" value={r.key} onChange={e => setEnvAt(i, { key: e.target.value })} placeholder="ANTHROPIC_API_KEY" />
                {r.secret ? (
                  <select className="flex-1 border rounded-md h-9 px-2 bg-background text-sm" value={r.value} onChange={e => setEnvAt(i, { value: e.target.value })}>
                    <option value="">— pick secret —</option>
                    {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <Input className="flex-1 font-mono text-xs" value={r.value} onChange={e => setEnvAt(i, { value: e.target.value })} />
                )}
                <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <input type="checkbox" checked={r.secret} onChange={e => setEnvAt(i, { secret: e.target.checked, value: '' })} />secret
                </label>
                <Button size="sm" variant="ghost" onClick={() => setEnv(env.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setEnv([...env, { key: '', value: '', secret: false }])}>Add env var</Button>
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

- [ ] **Step 3: Rewrite `packages/ui/src/pages/ProfilesPage.tsx`** (full file):

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { ProfileEditor, type ProfileRow } from '@/components/ProfileEditor'

export function ProfilesPage() {
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [servers, setServers] = useState<string[]>([])
  const [secretNames, setSecretNames] = useState<string[]>([])
  const [name, setName] = useState(''); const [from, setFrom] = useState(''); const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ProfileRow | null>(null)
  const [deleting, setDeleting] = useState<ProfileRow | null>(null)

  const load = async () => {
    try { setRows(await api.profiles()) } catch (e: any) { toast.error(e.message) }
    try { setServers((await api.mcp()).servers) } catch { setServers([]) }         // 409 before adopt
    try { setSecretNames((await api.secrets()).names) } catch { setSecretNames([]) }
  }
  useEffect(() => { load() }, [])

  const doDelete = async (p: ProfileRow) => {
    try { await api.deleteProfile(p.name); toast.success(`Removed ${p.name} from manifest`); setDeleting(null); load() }
    catch (e: any) { toast.error(e.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Profiles</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Create profile</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New profile</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="work" /></div>
              <div className="space-y-1.5">
                <Label>Copy MCP / links from (optional)</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={from} onChange={e => setFrom(e.target.value)}>
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
        <TableHeader><TableRow>
          <TableHead>Name</TableHead><TableHead>Auth</TableHead><TableHead>Account</TableHead><TableHead>MCP</TableHead><TableHead>Launcher</TableHead><TableHead>Env</TableHead><TableHead className="w-32" />
        </TableRow></TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.name}>
              <TableCell className="font-medium">{r.name}{!r.adopted && <span className="text-muted-foreground" title="not in manifest — adopt to manage"> *</span>}</TableCell>
              <TableCell>{r.auth}</TableCell>
              <TableCell className="text-muted-foreground">{r.account ?? '—'}</TableCell>
              <TableCell>{r.mcp}</TableCell>
              <TableCell className="font-mono text-xs">{r.launcher ?? '—'}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{Object.keys(r.env).length || '—'}</TableCell>
              <TableCell>
                <div className="flex gap-1 justify-end">
                  <Button size="sm" variant="ghost" disabled={!r.adopted} title={r.adopted ? undefined : 'Adopt first'} onClick={() => setEditing(r)}>Edit</Button>
                  <Button size="sm" variant="ghost" disabled={!r.adopted} title={r.adopted ? undefined : 'Adopt first'} onClick={() => setDeleting(r)}>Delete</Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editing && (
        <ProfileEditor profile={editing} servers={servers} secretNames={secretNames}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}

      {deleting && (
        <Dialog open onOpenChange={o => { if (!o) setDeleting(null) }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete profile "{deleting.name}"?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              Removes it from the manifest and drops its launcher from your shell rc on apply.
              The directory <span className="font-mono">{deleting.dir}</span> stays on disk — re-adopt to manage it again.
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => doDelete(deleting)}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
```

Note: if `packages/ui/src/components/ui/button.tsx` has no `destructive` variant, use `variant="default"` with `className="bg-red-600 hover:bg-red-700 text-white"` instead — check the button component first.

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/api.ts packages/ui/src/components/ProfileEditor.tsx packages/ui/src/pages/ProfilesPage.tsx packages/cli/webui
git commit -m "feat(ui): profile editor (env/secrets/links/launcher/mcp) and manifest-only delete"
```

(If `npm run build` regenerates bundled UI assets elsewhere — check `scripts/copy-ui.mjs` output dir — include whatever changed under version control per existing repo convention; if dist assets are gitignored, just commit the sources.)

---

### Task 5: UI — Shell RC tab

**Files:**
- Create: `packages/ui/src/pages/RcPage.tsx`
- Modify: `packages/ui/src/App.tsx`

**Interfaces:**
- Consumes: `api.rc()` / `api.updateRc()` from Task 4 step 1; Task 3 response shapes.

- [ ] **Step 1: Create `packages/ui/src/pages/RcPage.tsx`**:

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Rc = { rcFile: string; current: string | null; rendered: string; inSync: boolean }

function Block({ title, lines, otherLines, tint }: { title: string; lines: string[]; otherLines: Set<string>; tint: string }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium mb-1.5">{title}</div>
      <pre className="border rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre">
        {lines.map((l, i) => (
          <div key={i} className={cn('px-1 -mx-1 rounded-sm', !otherLines.has(l) && l.trim() !== '' && tint)}>{l || ' '}</div>
        ))}
      </pre>
    </div>
  )
}

export function RcPage() {
  const [rc, setRc] = useState<Rc | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setRc(await api.rc()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  if (!rc) return <div className="text-sm text-muted-foreground">Loading…</div>

  const curLines = (rc.current ?? '').split('\n')
  const newLines = rc.rendered.split('\n')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          Shell RC
          <Badge variant={rc.inSync ? 'secondary' : 'default'}>{rc.inSync ? 'in sync' : 'out of sync'}</Badge>
        </h1>
        <Button disabled={rc.inSync || busy} onClick={async () => {
          setBusy(true)
          try {
            const r = await api.updateRc()
            toast.success(r.backupDir ? `Updated — backup in ${r.backupDir}` : 'Updated')
            load()
          } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
        }}>Update {rc.rcFile.split('/').pop()}</Button>
      </div>
      <div className="text-sm text-muted-foreground font-mono">{rc.rcFile}</div>
      <p className="text-sm text-muted-foreground">
        Only the managed block (between the ccprofiles markers) is ever rewritten. Everything else in the file is untouched.
      </p>
      <div className="flex gap-4">
        <Block title="Currently in file" lines={rc.current === null ? ['(no managed block yet)'] : curLines}
          otherLines={new Set(newLines)} tint="bg-red-500/10" />
        <Block title="From manifest" lines={newLines} otherLines={new Set(curLines)} tint="bg-green-500/10" />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Register the tab** — in `packages/ui/src/App.tsx`:

Add to imports:

```tsx
import { RcPage } from '@/pages/RcPage'
import { LayoutDashboard, Users, Boxes, KeyRound, RefreshCw, Stethoscope, Terminal } from 'lucide-react'
```

Add to `TABS` after the `secrets` entry:

```tsx
  ['rc', 'Shell RC', Terminal],
```

Add to the main pane:

```tsx
        {tab === 'rc' && <RcPage />}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/RcPage.tsx packages/ui/src/App.tsx
git commit -m "feat(ui): Shell RC tab — managed-block diff preview and one-click update"
```

---

### Task 6: UI — secrets usage badges + attach/detach

**Files:**
- Modify: `packages/ui/src/pages/SecretsPage.tsx` (full rewrite below)

**Interfaces:**
- Consumes: `ProfileRow` from Task 4; `api.profiles()` env data from Task 1; existing `api.patchProfile`.

- [ ] **Step 1: Rewrite `packages/ui/src/pages/SecretsPage.tsx`**:

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import type { ProfileRow } from '@/components/ProfileEditor'

const SECRET_PREFIX = 'secret://'
type Usage = { profile: string; envKey: string }

export function SecretsPage() {
  const [names, setNames] = useState<string[]>([]); const [backend, setBackend] = useState('')
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [shown, setShown] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false); const [f, setF] = useState({ name: '', value: '' })
  const [attaching, setAttaching] = useState<string | null>(null)
  const [att, setAtt] = useState({ profile: '', envKey: 'ANTHROPIC_API_KEY' })

  const load = async () => {
    try { const r = await api.secrets(); setNames(r.names); setBackend(r.backend) } catch (e: any) { toast.error(e.message) }
    try { setProfiles(await api.profiles()) } catch { setProfiles([]) }
  }
  useEffect(() => { load() }, [])

  const usage = (secret: string): Usage[] =>
    profiles.flatMap(p => Object.entries(p.env)
      .filter(([, v]) => v === SECRET_PREFIX + secret)
      .map(([envKey]) => ({ profile: p.name, envKey })))

  const reveal = async (n: string) => {
    if (shown[n] !== undefined) { const c = { ...shown }; delete c[n]; setShown(c); return }
    try { const r = await api.revealSecret(n); setShown({ ...shown, [n]: r.value }) } catch (e: any) { toast.error(e.message) }
  }

  const attach = async () => {
    if (!attaching || !att.profile || !att.envKey.trim()) return
    const p = profiles.find(x => x.name === att.profile)
    if (!p) return
    try {
      await api.patchProfile(p.name, { env: { ...p.env, [att.envKey.trim()]: SECRET_PREFIX + attaching } })
      toast.success(`Attached ${attaching} to ${p.name} as ${att.envKey.trim()}`)
      setAttaching(null); setAtt({ profile: '', envKey: 'ANTHROPIC_API_KEY' }); load()
    } catch (e: any) { toast.error(e.message) }
  }

  const detach = async (secret: string, u: Usage) => {
    const p = profiles.find(x => x.name === u.profile)
    if (!p) return
    const env = { ...p.env }; delete env[u.envKey]
    try { await api.patchProfile(p.name, { env }); toast.success(`Detached ${secret} from ${u.profile}`); load() }
    catch (e: any) { toast.error(e.message) }
  }

  const adopted = profiles.filter(p => p.adopted)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">Secrets <Badge variant="secondary">{backend}</Badge></h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={async () => {
            try { const r = await api.migrate(); toast.success(r.migrated.length ? `Migrated ${r.migrated.join(', ')}` : 'No plaintext keys found'); load() } catch (e: any) { toast.error(e.message) }
          }}>Migrate from rc</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add secret</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add secret</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5"><Label>Name</Label><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="anthropic-api-key" /></div>
                <div className="space-y-1.5"><Label>Value</Label><Input type="password" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} /></div>
              </div>
              <DialogFooter><Button onClick={async () => {
                try { await api.setSecret(f.name, f.value); toast.success(`Stored ${f.name}`); setOpen(false); setF({ name: '', value: '' }); load() } catch (e: any) { toast.error(e.message) }
              }}>Save</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="divide-y border rounded-lg">
        {names.map(n => {
          const used = usage(n)
          return (
            <div key={n} className="flex items-center justify-between p-3 gap-3">
              <div className="min-w-0">
                <div className="font-mono text-sm">{n}{shown[n] !== undefined && <span className="ml-3 text-muted-foreground">{shown[n]}</span>}</div>
                {used.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {used.map(u => (
                      <Badge key={`${u.profile}-${u.envKey}`} variant="secondary" className="font-mono text-[11px] gap-1">
                        {u.profile} · {u.envKey}
                        <button className="ml-0.5 hover:text-foreground" title="Detach" onClick={() => detach(n, u)}>×</button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setAttaching(n)}>Attach</Button>
                <Button size="sm" variant="ghost" onClick={() => reveal(n)}>{shown[n] !== undefined ? 'Hide' : 'Reveal'}</Button>
                <Button size="sm" variant="ghost" onClick={async () => { try { await api.rmSecret(n); toast.success(`Removed ${n}`); load() } catch (e: any) { toast.error(e.message) } }}>Delete</Button>
              </div>
            </div>
          )
        })}
        {names.length === 0 && <div className="p-3 text-sm text-muted-foreground">No secrets yet.</div>}
      </div>

      {attaching && (
        <Dialog open onOpenChange={o => { if (!o) setAttaching(null) }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Attach {attaching} to a profile</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Profile</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={att.profile} onChange={e => setAtt({ ...att, profile: e.target.value })}>
                  <option value="">— pick profile —</option>
                  {adopted.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Env var name</Label>
                <Input className="font-mono" value={att.envKey} onChange={e => setAtt({ ...att, envKey: e.target.value })} />
              </div>
              <p className="text-xs text-muted-foreground">
                The launcher will export it as <span className="font-mono">{att.envKey || 'VAR'}="$(ccprofiles secrets get {attaching})"</span> — the value never lands in your rc file.
              </p>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setAttaching(null)}>Cancel</Button>
              <Button disabled={!att.profile || !att.envKey.trim()} onClick={attach}>Attach</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/pages/SecretsPage.tsx
git commit -m "feat(ui): secrets show profile usage; attach/detach secrets to profile env"
```

---

### Task 7: Full test suite + sandboxed end-to-end verify

**Files:** none new (fixes only, if anything fails)

- [ ] **Step 1: Full build + test run**

Run: `npm run build && npm test`
Expected: build exits 0; all vitest suites pass (including pre-existing ui-* suites).

- [ ] **Step 2: Sandboxed end-to-end verify**

Use the project-scoped `Development/personal/ccprofiles:verify` skill (sandboxed home; never touches real `~/.claude*` or the keychain). Exercise at least:
1. adopt → create profile `work` → `GET /api/profiles` shows `env/links/mcpNames`
2. edit flow equivalent: `PATCH` env with a `secret://` ref → `GET /api/rc` shows the launcher exporting via `ccprofiles secrets get`
3. `POST /api/rc` → block written, backup created, outside content preserved
4. `DELETE /api/profiles/work` → gone from manifest + rc, dir intact
5. `clp ui` boots and serves the built UI (spot-check `/` returns HTML and `/api/profiles` with token works)

- [ ] **Step 3: Fix anything that failed, re-run, then commit any fixes**

```bash
git add -A
git commit -m "test: e2e verification fixes for comprehensive ui"
```

(Skip the commit if nothing changed.)

- [ ] **Step 4: Final commit of built webui assets if the repo tracks them**

Check: `git status` — if `packages/cli/webui/` (or the copy-ui.mjs destination) shows tracked modifications, commit them:

```bash
git add packages/cli/webui
git commit -m "build: refresh bundled webui assets"
```
