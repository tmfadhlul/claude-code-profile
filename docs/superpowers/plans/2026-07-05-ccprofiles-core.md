# ccprofiles Core (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-platform Node CLI (`ccp`) that discovers/adopts multi-profile Claude Code setups, manages MCP servers across profiles, stores secrets in an OS keychain (with encrypted-file fallback), and applies a platform-neutral manifest back to live config dirs.

**Architecture:** npm-workspaces monorepo. `packages/core` is a pure library (discovery, manifest, platform adapters, rc-block writer, secrets, apply planner/executor); `packages/cli` is a thin commander layer. All fs-touching functions take injectable roots (`home`, manifest root) so tests run against temp dirs.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `commander`, `yaml`, `zod`, `vitest`.

**Plan 2 (separate):** LAN sync (serve/pair/sync/devices), bundle export/import, npm packaging + CI.

## Global Constraints

- Node ≥ 20, ESM only (`"type": "module"`).
- Runtime deps limited to: `commander`, `yaml`, `zod`. No native modules (keychain via shelling out to `security`/`secret-tool`/PowerShell).
- Never read or write: `history.jsonl`, `projects/`, `sessions/`, `session-env/`, caches, OAuth session state.
- Surgical writes only: ccprofiles owns the `mcpServers` key in `.claude.json`, its managed rc block, and links it creates. Whole-file rewrites of user files are forbidden.
- Every mutating operation: atomic write (tmp + rename), backup touched files to `~/.ccprofiles/backups/<ISO-timestamp>/` first, support `--dry-run`.
- Manifest path templating: `{home}` placeholder; secrets referenced as `secret://<name>`; secret values never enter the manifest.
- Profile naming: dir `.claude` → profile `default` (no `CLAUDE_CONFIG_DIR` in its launcher); dir `.claude-<x>` → profile `<x>`, launcher `cl-<x>`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`

**Interfaces:**
- Produces: workspace layout every later task assumes; `@ccprofiles/core` importable from cli package.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "ccprofiles-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "build": "tsc -b packages/core packages/cli"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": { "node": ">=20" }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'] } })
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 2: Package files**

`packages/core/package.json`:
```json
{
  "name": "@ccprofiles/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": { "yaml": "^2.5.0", "zod": "^3.23.0" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/cli/package.json`:
```json
{
  "name": "ccprofiles",
  "version": "0.1.0",
  "type": "module",
  "bin": { "ccprofiles": "./dist/index.js", "ccp": "./dist/index.js" },
  "dependencies": { "@ccprofiles/core": "0.1.0", "commander": "^12.1.0" }
}
```

`packages/cli/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"], "references": [{ "path": "../core" }] }
```

`packages/core/src/index.ts`: `export {}` (placeholder, replaced as modules land)
`packages/cli/src/index.ts`:
```ts
#!/usr/bin/env node
console.log('ccprofiles')
```

- [ ] **Step 3: Install and verify**

Run: `npm install && npm run build && node packages/cli/dist/index.js`
Expected: prints `ccprofiles`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold npm-workspaces monorepo (core + cli)"
```

---

### Task 2: Platform module

**Files:**
- Create: `packages/core/src/platform.ts`
- Test: `packages/core/test/platform.test.ts`

**Interfaces:**
- Produces:
  - `type OsKind = 'darwin' | 'linux' | 'win32'`
  - `interface Platform { os: OsKind; home: string; rcFile: string }`
  - `detectPlatform(opts?: { osKind?: OsKind; home?: string; shell?: string }): Platform`
  - `renderPath(template: string, p: Platform): string` — `{home}` → real home, `/`→`\` on win32
  - `toTemplate(absPath: string, p: Platform): string` — inverse (templated, forward slashes)

- [ ] **Step 1: Write failing tests**

`packages/core/test/platform.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { detectPlatform, renderPath, toTemplate } from '../src/platform.js'

describe('platform', () => {
  const mac = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
  const win = detectPlatform({ osKind: 'win32', home: 'C:\\Users\\x' })

  it('picks zshrc for zsh shells', () => {
    expect(mac.rcFile).toBe('/Users/x/.zshrc')
  })
  it('picks bashrc otherwise', () => {
    expect(detectPlatform({ osKind: 'linux', home: '/home/x', shell: '/bin/bash' }).rcFile).toBe('/home/x/.bashrc')
  })
  it('picks PowerShell profile on windows', () => {
    expect(win.rcFile).toBe('C:\\Users\\x\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1')
  })
  it('renders {home} and separators', () => {
    expect(renderPath('{home}/.claude-oauth', mac)).toBe('/Users/x/.claude-oauth')
    expect(renderPath('{home}/.claude-oauth', win)).toBe('C:\\Users\\x\\.claude-oauth')
  })
  it('templates absolute paths back', () => {
    expect(toTemplate('/Users/x/.claude-oauth', mac)).toBe('{home}/.claude-oauth')
    expect(toTemplate('C:\\Users\\x\\.claude-oauth', win)).toBe('{home}/.claude-oauth')
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run packages/core/test/platform.test.ts` → FAIL (module not found)

- [ ] **Step 3: Implement**

`packages/core/src/platform.ts`:
```ts
import os from 'node:os'
import path from 'node:path'

export type OsKind = 'darwin' | 'linux' | 'win32'
export interface Platform { os: OsKind; home: string; rcFile: string }

export function detectPlatform(opts: { osKind?: OsKind; home?: string; shell?: string } = {}): Platform {
  const osKind = opts.osKind ?? (process.platform as OsKind)
  const home = opts.home ?? os.homedir()
  const shell = opts.shell ?? process.env.SHELL ?? ''
  const rcFile = osKind === 'win32'
    ? path.win32.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    : path.posix.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bashrc')
  return { os: osKind, home, rcFile }
}

export function renderPath(template: string, p: Platform): string {
  const raw = template.replaceAll('{home}', p.home)
  return p.os === 'win32' ? raw.replaceAll('/', '\\') : raw
}

export function toTemplate(absPath: string, p: Platform): string {
  const norm = absPath.replaceAll('\\', '/')
  const home = p.home.replaceAll('\\', '/')
  return norm.startsWith(home) ? '{home}' + norm.slice(home.length) : norm
}
```

Re-export from `packages/core/src/index.ts`:
```ts
export * from './platform.js'
```

- [ ] **Step 4: Run to verify pass** — same command → PASS
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): platform detection and path templating"`

---

### Task 3: Manifest types, parse/serialize/validate

**Files:**
- Create: `packages/core/src/manifest.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/test/manifest.test.ts`

**Interfaces:**
- Produces:
  - `interface McpServerDef { command: string; args?: string[]; env?: Record<string,string>; type?: string; url?: string }`
  - `interface ProfileDecl { name: string; dir: string; launcher: string | null; auth: 'oauth'|'api-key'|'env'; env: Record<string,string>; links: Record<string,string>; mcp: string[] }`
  - `interface Manifest { version: 1; hub: string | null; profiles: ProfileDecl[]; mcpServers: Record<string, McpServerDef> }`
  - `parseManifest(text: string): Manifest` (throws `ManifestError` with message on invalid)
  - `serializeManifest(m: Manifest): string`
  - `loadManifest(root: string): Promise<Manifest>` / `saveManifest(root: string, m: Manifest): Promise<void>` — reads/writes `<root>/manifest.yaml`, `saveManifest` creates root dir if missing and runs `git add -A && git commit` in root when a git repo exists (best-effort, ignore failure).

- [ ] **Step 1: Write failing tests**

`packages/core/test/manifest.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManifest, serializeManifest, loadManifest, saveManifest, ManifestError } from '../src/manifest.js'

const sample = {
  version: 1 as const,
  hub: 'default',
  profiles: [{
    name: 'oauth', dir: '{home}/.claude-oauth', launcher: 'cl-auth',
    auth: 'oauth' as const, env: {}, links: { skills: 'hub', commands: 'hub' }, mcp: ['playwright'],
  }],
  mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
}

describe('manifest', () => {
  it('round-trips through yaml', () => {
    expect(parseManifest(serializeManifest(sample))).toEqual(sample)
  })
  it('rejects unknown version', () => {
    expect(() => parseManifest('version: 2\nhub: null\nprofiles: []\nmcpServers: {}')).toThrow(ManifestError)
  })
  it('rejects profile referencing undefined mcp server', () => {
    const bad = { ...sample, mcpServers: {} }
    expect(() => parseManifest(serializeManifest(bad))).toThrow(/undefined mcp server/i)
  })
  it('loads and saves from a root dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccp-'))
    await saveManifest(root, sample)
    expect(await loadManifest(root)).toEqual(sample)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/manifest.ts`:
```ts
import { z } from 'zod'
import YAML from 'yaml'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export class ManifestError extends Error {}

const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  type: z.string().optional(),
  url: z.string().optional(),
}).passthrough()

const ProfileSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  launcher: z.string().nullable(),
  auth: z.enum(['oauth', 'api-key', 'env']),
  env: z.record(z.string()).default({}),
  links: z.record(z.string()).default({}),
  mcp: z.array(z.string()).default([]),
})

const ManifestSchema = z.object({
  version: z.literal(1),
  hub: z.string().nullable(),
  profiles: z.array(ProfileSchema),
  mcpServers: z.record(McpServerSchema),
})

export type McpServerDef = z.infer<typeof McpServerSchema>
export type ProfileDecl = z.infer<typeof ProfileSchema>
export type Manifest = z.infer<typeof ManifestSchema>

export function parseManifest(text: string): Manifest {
  let raw: unknown
  try { raw = YAML.parse(text) } catch (e) { throw new ManifestError(`invalid yaml: ${(e as Error).message}`) }
  const res = ManifestSchema.safeParse(raw)
  if (!res.success) throw new ManifestError(res.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  const m = res.data
  for (const p of m.profiles) for (const name of p.mcp)
    if (!m.mcpServers[name]) throw new ManifestError(`profile "${p.name}" references undefined mcp server "${name}"`)
  return m
}

export function serializeManifest(m: Manifest): string {
  return YAML.stringify(m)
}

export async function loadManifest(root: string): Promise<Manifest> {
  return parseManifest(await readFile(join(root, 'manifest.yaml'), 'utf8'))
}

export async function saveManifest(root: string, m: Manifest): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.yaml'), serializeManifest(m), 'utf8')
  try {
    await exec('git', ['-C', root, 'rev-parse', '--git-dir'])
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-m', 'ccprofiles: update manifest'])
  } catch { /* not a repo or nothing to commit — fine */ }
}
```

Add to `packages/core/src/index.ts`: `export * from './manifest.js'`

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(core): manifest schema, parse/serialize/load/save"`

---

### Task 4: Live-profile discovery

**Files:**
- Create: `packages/core/src/discovery.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/discovery.test.ts`

**Interfaces:**
- Consumes: `McpServerDef` from manifest.ts.
- Produces:
  - `interface LiveProfile { dirName: string; dir: string; configPath: string; account: string | null; mcpServers: Record<string, McpServerDef>; links: Record<string, string> }`
  - `discoverProfiles(home: string): Promise<LiveProfile[]>`
- Rules: candidates are directories in `home` named `.claude` or `.claude-*`. Config file is `<home>/.claude.json` for `.claude`, else `<dir>/.claude.json`. Dirs without a parseable config are skipped (e.g. `.claude-mem`). `links` maps entry name → symlink target for any symlinked top-level entries of the profile dir (e.g. `skills`, `commands`).

- [ ] **Step 1: Write failing tests**

`packages/core/test/discovery.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProfiles } from '../src/discovery.js'

let home: string
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-home-'))
  // default profile: dir .claude + config at ~/.claude.json
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    oauthAccount: { emailAddress: 'a@b.c' },
  }))
  // named profile with symlinked skills
  await mkdir(join(home, '.claude-oauth'))
  await writeFile(join(home, '.claude-oauth', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await symlink(join(home, '.claude', 'skills'), join(home, '.claude-oauth', 'skills'))
  // non-profile dir
  await mkdir(join(home, '.claude-mem'))
})

describe('discoverProfiles', () => {
  it('finds profiles, skips non-profiles', async () => {
    const found = await discoverProfiles(home)
    expect(found.map(p => p.dirName).sort()).toEqual(['.claude', '.claude-oauth'])
  })
  it('reads account and mcpServers from default profile config in home', async () => {
    const def = (await discoverProfiles(home)).find(p => p.dirName === '.claude')!
    expect(def.account).toBe('a@b.c')
    expect(Object.keys(def.mcpServers)).toEqual(['playwright'])
  })
  it('captures symlinks', async () => {
    const oauth = (await discoverProfiles(home)).find(p => p.dirName === '.claude-oauth')!
    expect(oauth.links.skills).toBe(join(home, '.claude', 'skills'))
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/discovery.ts`:
```ts
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerDef } from './manifest.js'

export interface LiveProfile {
  dirName: string
  dir: string
  configPath: string
  account: string | null
  mcpServers: Record<string, McpServerDef>
  links: Record<string, string>
}

export async function discoverProfiles(home: string): Promise<LiveProfile[]> {
  const entries = await readdir(home, { withFileTypes: true })
  const out: LiveProfile[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !(e.name === '.claude' || e.name.startsWith('.claude-'))) continue
    const dir = join(home, e.name)
    const configPath = e.name === '.claude' ? join(home, '.claude.json') : join(dir, '.claude.json')
    let cfg: any
    try { cfg = JSON.parse(await readFile(configPath, 'utf8')) } catch { continue }
    const links: Record<string, string> = {}
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (child.isSymbolicLink()) {
        try { links[child.name] = await readlink(join(dir, child.name)) } catch { /* skip */ }
      }
    }
    out.push({
      dirName: e.name,
      dir,
      configPath,
      account: cfg?.oauthAccount?.emailAddress ?? null,
      mcpServers: cfg?.mcpServers ?? {},
      links,
    })
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName))
}
```

Add to index: `export * from './discovery.js'`

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(core): live profile discovery"`

---

### Task 5: Adopt (live → manifest)

**Files:**
- Create: `packages/core/src/adopt.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/adopt.test.ts`

**Interfaces:**
- Consumes: `LiveProfile`, `Manifest`, `Platform`, `toTemplate`.
- Produces: `buildManifest(profiles: LiveProfile[], platform: Platform): Manifest`
- Rules: profile name from dirName (`.claude`→`default`, `.claude-x`→`x`); launcher `cl-<name>` (`null` for `default` — user launches plain `claude`); `default` profile gets no `CLAUDE_CONFIG_DIR`; auth `oauth` when account present else `env`; MCP defs merged by name across profiles — first definition wins, identical re-definitions fine; a profile's `mcp` list is its server names. `hub` is the profile most linked-to by others (or `null`). Links pointing inside another profile's dir become `hub`; others kept as templated paths.

- [ ] **Step 1: Write failing tests**

`packages/core/test/adopt.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildManifest } from '../src/adopt.js'
import { detectPlatform } from '../src/platform.js'
import type { LiveProfile } from '../src/discovery.js'

const p = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const live: LiveProfile[] = [
  { dirName: '.claude', dir: '/Users/x/.claude', configPath: '/Users/x/.claude.json',
    account: 'a@b.c', links: {},
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
  { dirName: '.claude-oauth', dir: '/Users/x/.claude-oauth', configPath: '/Users/x/.claude-oauth/.claude.json',
    account: 'a@b.c', links: { skills: '/Users/x/.claude/skills' },
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] } } },
]

describe('buildManifest', () => {
  const m = buildManifest(live, p)
  it('names profiles and launchers', () => {
    expect(m.profiles.map(x => [x.name, x.launcher])).toEqual([['default', null], ['oauth', 'cl-oauth']])
  })
  it('merges mcp defs and per-profile lists', () => {
    expect(Object.keys(m.mcpServers).sort()).toEqual(['playwright', 'shadcn'])
    expect(m.profiles.find(x => x.name === 'oauth')!.mcp.sort()).toEqual(['playwright', 'shadcn'])
  })
  it('marks hub links', () => {
    expect(m.hub).toBe('default')
    expect(m.profiles.find(x => x.name === 'oauth')!.links.skills).toBe('hub')
  })
  it('templates dirs', () => {
    expect(m.profiles.find(x => x.name === 'oauth')!.dir).toBe('{home}/.claude-oauth')
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/adopt.ts`:
```ts
import type { LiveProfile } from './discovery.js'
import type { Manifest, ProfileDecl } from './manifest.js'
import { toTemplate, type Platform } from './platform.js'

function profileName(dirName: string): string {
  return dirName === '.claude' ? 'default' : dirName.slice('.claude-'.length)
}

export function buildManifest(live: LiveProfile[], platform: Platform): Manifest {
  const mcpServers: Manifest['mcpServers'] = {}
  for (const lp of live)
    for (const [name, def] of Object.entries(lp.mcpServers))
      mcpServers[name] ??= def

  // hub = profile whose dir is the most common link target prefix
  const linkVotes = new Map<string, number>()
  for (const lp of live)
    for (const target of Object.values(lp.links)) {
      const owner = live.find(o => o !== lp && target.startsWith(o.dir))
      if (owner) linkVotes.set(owner.dirName, (linkVotes.get(owner.dirName) ?? 0) + 1)
    }
  const hubDirName = [...linkVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const hub = hubDirName ? profileName(hubDirName) : null

  const profiles: ProfileDecl[] = live.map(lp => {
    const name = profileName(lp.dirName)
    const links: Record<string, string> = {}
    for (const [entry, target] of Object.entries(lp.links)) {
      const isHubLink = hubDirName && target.startsWith(live.find(o => o.dirName === hubDirName)!.dir)
      links[entry] = isHubLink ? 'hub' : toTemplate(target, platform)
    }
    return {
      name,
      dir: toTemplate(lp.dir, platform),
      launcher: name === 'default' ? null : `cl-${name}`,
      auth: lp.account ? ('oauth' as const) : ('env' as const),
      env: {},
      links,
      mcp: Object.keys(lp.mcpServers).sort(),
    }
  })

  return { version: 1, hub, profiles, mcpServers }
}
```

Add to index: `export * from './adopt.js'`

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(core): adopt — build manifest from live profiles"`

---

### Task 6: rc managed block (render + upsert)

**Files:**
- Create: `packages/core/src/rcblock.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/rcblock.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `Platform`, `renderPath`.
- Produces:
  - `renderRcBlock(m: Manifest, p: Platform): string`
  - `upsertManagedBlock(content: string, block: string): string`
  - Markers: `# >>> ccprofiles managed >>>` / `# <<< ccprofiles managed <<<` (same for PowerShell — `#` comments work there too).
- Rules: one launcher function per profile with non-null `launcher`. POSIX shape:
  ```
  cl-oauth() {
    export FOO="$(ccp secrets get foo)"   # only for env entries; secret:// via ccp secrets get
    CLAUDE_CONFIG_DIR="$HOME/.claude-oauth" claude "$@"
  }
  ```
  `{home}` renders as literal `$HOME` in POSIX rc, `$env:USERPROFILE` in PowerShell (so the block is machine-portable). PowerShell shape:
  ```
  function cl-oauth {
    $env:FOO = (ccp secrets get foo)
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-oauth"
    claude @args
  }
  ```

- [ ] **Step 1: Write failing tests**

`packages/core/test/rcblock.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { renderRcBlock, upsertManagedBlock, BEGIN_MARK, END_MARK } from '../src/rcblock.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'

const m: Manifest = {
  version: 1, hub: null,
  profiles: [
    { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {}, links: {}, mcp: [] },
    { name: 'z', dir: '{home}/.claude-z', launcher: 'cl-z', auth: 'env',
      env: { ANTHROPIC_AUTH_TOKEN: 'secret://z-token', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      links: {}, mcp: [] },
  ],
  mcpServers: {},
}
const mac = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
const win = detectPlatform({ osKind: 'win32', home: 'C:\\Users\\x' })

describe('renderRcBlock', () => {
  it('renders posix launchers with secret indirection, skips null launchers', () => {
    const block = renderRcBlock(m, mac)
    expect(block).toContain(BEGIN_MARK)
    expect(block).toContain('cl-z() {')
    expect(block).toContain('export ANTHROPIC_AUTH_TOKEN="$(ccp secrets get z-token)"')
    expect(block).toContain('export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"')
    expect(block).toContain('CLAUDE_CONFIG_DIR="$HOME/.claude-z" claude "$@"')
    expect(block).not.toContain('cl-default')
    expect(block).toContain(END_MARK)
  })
  it('renders powershell launchers on win32', () => {
    const block = renderRcBlock(m, win)
    expect(block).toContain('function cl-z {')
    expect(block).toContain('$env:ANTHROPIC_AUTH_TOKEN = (ccp secrets get z-token)')
    expect(block).toContain('$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-z"')
    expect(block).toContain('claude @args')
  })
})

describe('upsertManagedBlock', () => {
  it('appends when absent', () => {
    const out = upsertManagedBlock('export PATH=/x\n', `${BEGIN_MARK}\nX\n${END_MARK}`)
    expect(out).toBe(`export PATH=/x\n\n${BEGIN_MARK}\nX\n${END_MARK}\n`)
  })
  it('replaces in place when present, preserving surroundings', () => {
    const existing = `before\n${BEGIN_MARK}\nOLD\n${END_MARK}\nafter\n`
    const out = upsertManagedBlock(existing, `${BEGIN_MARK}\nNEW\n${END_MARK}`)
    expect(out).toBe(`before\n${BEGIN_MARK}\nNEW\n${END_MARK}\nafter\n`)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/rcblock.ts`:
```ts
import type { Manifest, ProfileDecl } from './manifest.js'
import type { Platform } from './platform.js'

export const BEGIN_MARK = '# >>> ccprofiles managed >>>'
export const END_MARK = '# <<< ccprofiles managed <<<'
const SECRET_PREFIX = 'secret://'

function homeVar(p: Platform): string {
  return p.os === 'win32' ? '$env:USERPROFILE' : '$HOME'
}

function profileDirExpr(pr: ProfileDecl, p: Platform): string {
  const suffix = pr.dir.replace('{home}', '')
  return p.os === 'win32' ? homeVar(p) + suffix.replaceAll('/', '\\') : homeVar(p) + suffix
}

function renderPosix(pr: ProfileDecl, p: Platform): string {
  const lines = [`${pr.launcher}() {`]
  for (const [k, v] of Object.entries(pr.env)) {
    lines.push(v.startsWith(SECRET_PREFIX)
      ? `  export ${k}="$(ccp secrets get ${v.slice(SECRET_PREFIX.length)})"`
      : `  export ${k}="${v}"`)
  }
  lines.push(`  CLAUDE_CONFIG_DIR="${profileDirExpr(pr, p)}" claude "$@"`, '}')
  return lines.join('\n')
}

function renderPwsh(pr: ProfileDecl, p: Platform): string {
  const lines = [`function ${pr.launcher} {`]
  for (const [k, v] of Object.entries(pr.env)) {
    lines.push(v.startsWith(SECRET_PREFIX)
      ? `  $env:${k} = (ccp secrets get ${v.slice(SECRET_PREFIX.length)})`
      : `  $env:${k} = "${v}"`)
  }
  lines.push(`  $env:CLAUDE_CONFIG_DIR = "${profileDirExpr(pr, p)}"`, '  claude @args', '}')
  return lines.join('\n')
}

export function renderRcBlock(m: Manifest, p: Platform): string {
  const fns = m.profiles
    .filter(pr => pr.launcher)
    .map(pr => (p.os === 'win32' ? renderPwsh(pr, p) : renderPosix(pr, p)))
  return [BEGIN_MARK, ...fns, END_MARK].join('\n')
}

export function upsertManagedBlock(content: string, block: string): string {
  const start = content.indexOf(BEGIN_MARK)
  const end = content.indexOf(END_MARK)
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + block + content.slice(end + END_MARK.length)
  }
  return content.trimEnd() + (content.trim() ? '\n\n' : '') + block + '\n'
}
```

Add to index: `export * from './rcblock.js'`

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(core): managed rc block renderer (posix + powershell)"`

---

### Task 7: fs utils — atomic write + backups

**Files:**
- Create: `packages/core/src/fsutil.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/fsutil.test.ts`

**Interfaces:**
- Produces:
  - `atomicWrite(filePath: string, content: string): Promise<void>` — writes `<file>.ccp-tmp` then renames.
  - `backupFiles(files: string[], backupRoot: string, stamp: string): Promise<string>` — copies each existing file to `<backupRoot>/<stamp>/<sanitized-abs-path>`; returns backup dir. Missing files skipped. Sanitization: strip drive colon, replace path separators with `__`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/fsutil.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, backupFiles } from '../src/fsutil.js'

describe('fsutil', () => {
  it('atomicWrite writes content and leaves no tmp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const f = join(dir, 'a.json')
    await atomicWrite(f, '{"x":1}')
    expect(await readFile(f, 'utf8')).toBe('{"x":1}')
    expect((await readdir(dir)).filter(n => n.includes('ccp-tmp'))).toEqual([])
  })
  it('backupFiles copies existing, skips missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const src = join(dir, 'x.txt')
    await writeFile(src, 'hi')
    const backupDir = await backupFiles([src, join(dir, 'missing.txt')], join(dir, 'backups'), '2026-07-05T00-00-00')
    const copied = await readdir(backupDir)
    expect(copied).toHaveLength(1)
    expect(await readFile(join(backupDir, copied[0]), 'utf8')).toBe('hi')
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/fsutil.ts`:
```ts
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.ccp-tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

function sanitize(absPath: string): string {
  return absPath.replace(/:/g, '').replace(/[\\/]+/g, '__').replace(/^__/, '')
}

export async function backupFiles(files: string[], backupRoot: string, stamp: string): Promise<string> {
  const dir = join(backupRoot, stamp)
  await mkdir(dir, { recursive: true })
  for (const f of files) {
    if (!existsSync(f)) continue
    await copyFile(f, join(dir, sanitize(f)))
  }
  return dir
}
```

Add to index: `export * from './fsutil.js'`

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(core): atomic write and backup utilities"`

---

### Task 8: Secrets store

**Files:**
- Create: `packages/core/src/secrets.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/secrets.test.ts`

**Interfaces:**
- Produces:
  - `interface SecretsBackend { readonly name: string; get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }`
  - `class FileBackend implements SecretsBackend` — AES-256-GCM, scrypt-derived key from passphrase; stores JSON `{ salt, entries: { [key]: { iv, tag, data } } }` (all base64) at given path. Constructor `new FileBackend(filePath: string, passphrase: string)`.
  - `class KeychainBackend implements SecretsBackend` — macOS `security` CLI: set = `security add-generic-password -U -s ccprofiles -a <key> -w <value>`, get = `security find-generic-password -s ccprofiles -a <key> -w` (null on non-zero exit), delete = `security delete-generic-password -s ccprofiles -a <key>`. Constructor takes optional exec fn for testing.
  - `class SecretsStore { constructor(backend: SecretsBackend, indexPath: string); get/set/delete; list(): Promise<string[]> }` — maintains name index (names only, JSON array) at `indexPath`.
  - `defaultBackend(p: Platform, opts: { filePath: string; passphrase?: () => Promise<string> }): Promise<SecretsBackend>` — darwin → Keychain; linux → `secret-tool` if on PATH else FileBackend; win32 → FileBackend for v1 (DPAPI in Plan 2); FileBackend prompts passphrase via `opts.passphrase`.
- Unit tests cover FileBackend round-trip + wrong passphrase, SecretsStore index, KeychainBackend arg construction with a stubbed exec. (Real keychain exercised manually.)

- [ ] **Step 1: Write failing tests**

`packages/core/test/secrets.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBackend, KeychainBackend, SecretsStore } from '../src/secrets.js'

describe('FileBackend', () => {
  it('round-trips and deletes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const b = new FileBackend(join(dir, 's.enc'), 'pw')
    await b.set('api-key', 'sk-ant-123')
    expect(await b.get('api-key')).toBe('sk-ant-123')
    await b.delete('api-key')
    expect(await b.get('api-key')).toBeNull()
  })
  it('fails closed on wrong passphrase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    await new FileBackend(join(dir, 's.enc'), 'right').set('k', 'v')
    await expect(new FileBackend(join(dir, 's.enc'), 'wrong').get('k')).rejects.toThrow()
  })
})

describe('KeychainBackend', () => {
  it('builds correct security invocations', async () => {
    const calls: string[][] = []
    const fakeExec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: 'v\n' } }
    const b = new KeychainBackend(fakeExec as any)
    await b.set('k', 'v')
    expect(calls[0]).toEqual(['security', 'add-generic-password', '-U', '-s', 'ccprofiles', '-a', 'k', '-w', 'v'])
    expect(await b.get('k')).toBe('v')
    expect(calls[1]).toEqual(['security', 'find-generic-password', '-s', 'ccprofiles', '-a', 'k', '-w'])
  })
})

describe('SecretsStore', () => {
  it('tracks names in index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccp-'))
    const store = new SecretsStore(new FileBackend(join(dir, 's.enc'), 'pw'), join(dir, 'index.json'))
    await store.set('a', '1'); await store.set('b', '2'); await store.delete('a')
    expect(await store.list()).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/secrets.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomicWrite } from './fsutil.js'
import type { Platform } from './platform.js'

export interface SecretsBackend {
  readonly name: string
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type EncFile = { salt: string; entries: Record<string, { iv: string; tag: string; data: string }> }

export class FileBackend implements SecretsBackend {
  readonly name = 'encrypted-file'
  constructor(private filePath: string, private passphrase: string) {}

  private async load(): Promise<EncFile> {
    if (!existsSync(this.filePath)) return { salt: randomBytes(16).toString('base64'), entries: {} }
    return JSON.parse(await readFile(this.filePath, 'utf8'))
  }
  private key(salt: string): Buffer {
    return scryptSync(this.passphrase, Buffer.from(salt, 'base64'), 32)
  }
  async get(key: string): Promise<string | null> {
    const f = await this.load()
    const e = f.entries[key]
    if (!e) return null
    const d = createDecipheriv('aes-256-gcm', this.key(f.salt), Buffer.from(e.iv, 'base64'))
    d.setAuthTag(Buffer.from(e.tag, 'base64'))
    return d.update(Buffer.from(e.data, 'base64')).toString('utf8') + d.final('utf8') // throws on bad passphrase
  }
  async set(key: string, value: string): Promise<void> {
    const f = await this.load()
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key(f.salt), iv)
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()])
    f.entries[key] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
    await atomicWrite(this.filePath, JSON.stringify(f))
  }
  async delete(key: string): Promise<void> {
    const f = await this.load()
    delete f.entries[key]
    await atomicWrite(this.filePath, JSON.stringify(f))
  }
}

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>
const realExec: ExecFn = promisify(execFile) as unknown as ExecFn

export class KeychainBackend implements SecretsBackend {
  readonly name = 'macos-keychain'
  constructor(private exec: ExecFn = realExec) {}
  async set(key: string, value: string): Promise<void> {
    await this.exec('security', ['add-generic-password', '-U', '-s', 'ccprofiles', '-a', key, '-w', value])
  }
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec('security', ['find-generic-password', '-s', 'ccprofiles', '-a', key, '-w'])
      return stdout.replace(/\n$/, '')
    } catch { return null }
  }
  async delete(key: string): Promise<void> {
    try { await this.exec('security', ['delete-generic-password', '-s', 'ccprofiles', '-a', key]) } catch { /* absent */ }
  }
}

export class SecretToolBackend implements SecretsBackend {
  readonly name = 'libsecret'
  constructor(private exec: ExecFn = realExec) {}
  async set(key: string, value: string): Promise<void> {
    // secret-tool reads the secret from stdin; use sh -c with printf to avoid exposing in args
    await this.exec('sh', ['-c', `printf %s "$CCP_SECRET" | secret-tool store --label=ccprofiles service ccprofiles key ${key}`])
      .catch(() => { throw new Error('secret-tool store failed') })
  }
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec('secret-tool', ['lookup', 'service', 'ccprofiles', 'key', key])
      return stdout
    } catch { return null }
  }
  async delete(key: string): Promise<void> {
    try { await this.exec('secret-tool', ['clear', 'service', 'ccprofiles', 'key', key]) } catch { /* absent */ }
  }
}

export class SecretsStore {
  constructor(private backend: SecretsBackend, private indexPath: string) {}
  private async readIndex(): Promise<string[]> {
    if (!existsSync(this.indexPath)) return []
    return JSON.parse(await readFile(this.indexPath, 'utf8'))
  }
  private async writeIndex(names: string[]): Promise<void> {
    await atomicWrite(this.indexPath, JSON.stringify([...new Set(names)].sort()))
  }
  get backendName(): string { return this.backend.name }
  async get(key: string): Promise<string | null> { return this.backend.get(key) }
  async set(key: string, value: string): Promise<void> {
    await this.backend.set(key, value)
    await this.writeIndex([...(await this.readIndex()), key])
  }
  async delete(key: string): Promise<void> {
    await this.backend.delete(key)
    await this.writeIndex((await this.readIndex()).filter(n => n !== key))
  }
  async list(): Promise<string[]> { return this.readIndex() }
}

export async function defaultBackend(
  p: Platform,
  opts: { filePath: string; passphrase?: () => Promise<string> },
): Promise<SecretsBackend> {
  if (p.os === 'darwin') return new KeychainBackend()
  if (p.os === 'linux') {
    try { await realExec('secret-tool', ['--help']); return new SecretToolBackend() } catch { /* fall through */ }
  }
  const pw = opts.passphrase ? await opts.passphrase() : ''
  if (!pw) throw new Error('encrypted-file backend requires a passphrase')
  return new FileBackend(opts.filePath, pw)
}
```

Note: `SecretToolBackend.set` requires passing `CCP_SECRET` in env — implement `exec` call with env injection when wiring the CLI (`execFile('sh', [...], { env: { ...process.env, CCP_SECRET: value } })`); keep the class's exec signature `(cmd, args, env?)` if needed during implementation — adjust test stubs accordingly.

Add to index: `export * from './secrets.js'`

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(core): secrets store with keychain and encrypted-file backends"`

---

### Task 9: Apply planner + executor

**Files:**
- Create: `packages/core/src/apply.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/apply.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `LiveProfile`, `discoverProfiles`, `Platform`, `renderPath`, `renderRcBlock`, `upsertManagedBlock`, `atomicWrite`, `backupFiles`.
- Produces:
  - `type ApplyAction = { kind: 'set-mcp-servers'; configPath: string; servers: Record<string, McpServerDef> } | { kind: 'create-profile-dir'; dir: string } | { kind: 'link'; from: string; to: string } | { kind: 'rc-block'; rcFile: string; block: string }`
  - `planApply(m: Manifest, live: LiveProfile[], p: Platform): ApplyAction[]`
  - `executeApply(actions: ApplyAction[], opts: { backupRoot: string; stamp: string; dryRun?: boolean }): Promise<{ backupDir: string | null; performed: string[] }>`
- Planner rules:
  - For each manifest profile: resolve its mcp names → defs; if the live profile's `mcpServers` differ (deep-equal on the resolved subset AND no extra/missing keys), emit `set-mcp-servers` with the full desired record.
  - If profile dir missing → `create-profile-dir` (and its config seeded as `{}` — the executor writes `{"mcpServers": {...}}` via set-mcp-servers on the new configPath).
  - For each `links` entry: desired target = hub profile's dir + `/<entry>` when value is `hub`, else `renderPath(value, p)`; emit `link` if missing or pointing elsewhere.
  - Always emit `rc-block` when rendered block differs from what's in the rc file (or file missing).
- Executor rules:
  - `set-mcp-servers`: read existing JSON (or `{}` if absent), replace ONLY `mcpServers` key, atomicWrite pretty-printed with 2 spaces.
  - `link`: `fs.symlink` with type `'junction'` on win32, `'dir'` otherwise; remove existing wrong link first (only if it IS a symlink — never delete a real dir; error instead).
  - `rc-block`: read rc (or ''), `upsertManagedBlock`, atomicWrite.
  - Backups: before executing, collect all file paths that will be written (config paths + rc file) and `backupFiles` them. dryRun: return planned `performed` strings without touching disk (backupDir null).

- [ ] **Step 1: Write failing tests**

`packages/core/test/apply.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planApply, executeApply } from '../src/apply.js'
import { discoverProfiles } from '../src/discovery.js'
import { detectPlatform } from '../src/platform.js'
import type { Manifest } from '../src/manifest.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-home-'))
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {}, otherKey: 'preserve-me' }))
})

function manifest(): Manifest {
  return {
    version: 1, hub: 'default',
    profiles: [
      { name: 'default', dir: '{home}/.claude', launcher: null, auth: 'oauth', env: {},
        links: {}, mcp: ['playwright'] },
      { name: 'new', dir: '{home}/.claude-new', launcher: 'cl-new', auth: 'env', env: {},
        links: { skills: 'hub' }, mcp: ['playwright'] },
    ],
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  }
}

describe('planApply + executeApply', () => {
  it('plans mcp update, new profile dir, hub link, rc block', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(manifest(), await discoverProfiles(home), p)
    const kinds = actions.map(a => a.kind).sort()
    expect(kinds).toEqual(['create-profile-dir', 'link', 'rc-block', 'set-mcp-servers', 'set-mcp-servers'])
  })

  it('executes: surgical json write preserves other keys', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(manifest(), await discoverProfiles(home), p)
    const res = await executeApply(actions, { backupRoot: join(home, '.ccprofiles', 'backups'), stamp: 't1' })
    const cfg = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
    expect(cfg.otherKey).toBe('preserve-me')
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
    expect(existsSync(join(home, '.claude-new', '.claude.json'))).toBe(true)
    expect(await readlink(join(home, '.claude-new', 'skills'))).toBe(join(home, '.claude', 'skills'))
    expect((await readFile(p.rcFile, 'utf8'))).toContain('cl-new()')
    expect(res.backupDir).not.toBeNull()
  })

  it('dry run touches nothing', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    const actions = planApply(manifest(), await discoverProfiles(home), p)
    await executeApply(actions, { backupRoot: join(home, 'b'), stamp: 't2', dryRun: true })
    expect(existsSync(join(home, '.claude-new'))).toBe(false)
  })

  it('is idempotent: second plan is empty', async () => {
    const p = detectPlatform({ osKind: process.platform as any, home, shell: '/bin/zsh' })
    await executeApply(planApply(manifest(), await discoverProfiles(home), p),
      { backupRoot: join(home, 'b'), stamp: 't3' })
    expect(planApply(manifest(), await discoverProfiles(home), p)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/core/src/apply.ts`:
```ts
import { lstat, mkdir, readFile, readlink, symlink, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Manifest, McpServerDef } from './manifest.js'
import type { LiveProfile } from './discovery.js'
import { renderPath, type Platform } from './platform.js'
import { renderRcBlock, upsertManagedBlock, BEGIN_MARK } from './rcblock.js'
import { atomicWrite, backupFiles } from './fsutil.js'

export type ApplyAction =
  | { kind: 'set-mcp-servers'; configPath: string; servers: Record<string, McpServerDef> }
  | { kind: 'create-profile-dir'; dir: string }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'rc-block'; rcFile: string; block: string }

function configPathFor(dir: string, home: string): string {
  return dir === join(home, '.claude') ? join(home, '.claude.json') : join(dir, '.claude.json')
}

export function planApply(m: Manifest, live: LiveProfile[], p: Platform): ApplyAction[] {
  const actions: ApplyAction[] = []
  const hubProfile = m.profiles.find(x => x.name === m.hub) ?? null

  for (const pr of m.profiles) {
    const dir = renderPath(pr.dir, p)
    const lp = live.find(l => l.dir === dir) ?? null
    const desired: Record<string, McpServerDef> = {}
    for (const name of pr.mcp) desired[name] = m.mcpServers[name]

    if (!lp) actions.push({ kind: 'create-profile-dir', dir })

    const current = lp?.mcpServers ?? null
    if (!current || JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(desired))) {
      actions.push({ kind: 'set-mcp-servers', configPath: configPathFor(dir, p.home), servers: desired })
    }

    for (const [entry, target] of Object.entries(pr.links)) {
      const to = target === 'hub' && hubProfile
        ? join(renderPath(hubProfile.dir, p), entry)
        : renderPath(target, p)
      const from = join(dir, entry)
      if (lp?.links[entry] === to) continue
      actions.push({ kind: 'link', from, to })
    }
  }

  const block = renderRcBlock(m, p)
  let rcCurrent = ''
  try { rcCurrent = existsSync(p.rcFile) ? require('node:fs').readFileSync(p.rcFile, 'utf8') : '' } catch { /* treat as empty */ }
  if (!rcCurrent.includes(block)) actions.push({ kind: 'rc-block', rcFile: p.rcFile, block })

  return actions
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

export async function executeApply(
  actions: ApplyAction[],
  opts: { backupRoot: string; stamp: string; dryRun?: boolean },
): Promise<{ backupDir: string | null; performed: string[] }> {
  const performed = actions.map(describe)
  if (opts.dryRun) return { backupDir: null, performed }

  const touched = actions.flatMap(a =>
    a.kind === 'set-mcp-servers' ? [a.configPath] : a.kind === 'rc-block' ? [a.rcFile] : [])
  const backupDir = touched.length ? await backupFiles(touched, opts.backupRoot, opts.stamp) : null

  for (const a of actions) {
    if (a.kind === 'create-profile-dir') {
      await mkdir(a.dir, { recursive: true })
    } else if (a.kind === 'set-mcp-servers') {
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(await readFile(a.configPath, 'utf8')) } catch { /* new file */ }
      cfg.mcpServers = a.servers
      await mkdir(dirname(a.configPath), { recursive: true })
      await atomicWrite(a.configPath, JSON.stringify(cfg, null, 2))
    } else if (a.kind === 'link') {
      try {
        const st = await lstat(a.from)
        if (!st.isSymbolicLink()) throw new Error(`refusing to replace non-symlink: ${a.from}`)
        await unlink(a.from)
      } catch (e: any) { if (e.code !== 'ENOENT') { if (e.message?.startsWith('refusing')) throw e } }
      await symlink(a.to, a.from, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (a.kind === 'rc-block') {
      let rc = ''
      try { rc = await readFile(a.rcFile, 'utf8') } catch { /* new file */ }
      await mkdir(dirname(a.rcFile), { recursive: true })
      await atomicWrite(a.rcFile, upsertManagedBlock(rc, a.block))
    }
  }
  return { backupDir, performed }
}

function describe(a: ApplyAction): string {
  switch (a.kind) {
    case 'set-mcp-servers': return `set mcpServers (${Object.keys(a.servers).length}) in ${a.configPath}`
    case 'create-profile-dir': return `create ${a.dir}`
    case 'link': return `link ${a.from} -> ${a.to}`
    case 'rc-block': return `update managed block in ${a.rcFile}`
  }
}
```

Implementation note: replace the `require('node:fs')` line with a top-of-file `import { readFileSync } from 'node:fs'` — shown inline here for brevity of the diff, but ESM has no `require`. The rc-block plan check must also handle "block present but stale": if `rcCurrent` contains `BEGIN_MARK` but not the exact rendered `block`, still emit the action (the `!rcCurrent.includes(block)` check covers this).

Add to index: `export * from './apply.js'`

- [ ] **Step 4: Run to verify pass** → PASS (all 4 tests, including idempotency)
- [ ] **Step 5: Commit** — `git commit -am "feat(core): apply planner and executor with backups and dry-run"`

---

### Task 10: CLI — context, `list`, `adopt`, `doctor`

**Files:**
- Create: `packages/cli/src/context.ts`, `packages/cli/src/commands/profiles.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Produces:
  - `interface CliContext { home: string; platform: Platform; manifestRoot: string; secretsIndexPath: string; secretsFilePath: string; backupRoot: string }`
  - `makeContext(env?: NodeJS.ProcessEnv): CliContext` — `manifestRoot` = `$CCPROFILES_HOME` or `<home>/.ccprofiles`; `backupRoot` = `<manifestRoot>/backups`; secrets paths under manifestRoot. `CCPROFILES_TEST_HOME` env var overrides home (integration tests).
  - Commands registered on a commander `program`; `buildProgram(ctx: CliContext): Command` exported for tests (invoke with `program.parseAsync(['node','ccp',...args])`).
- Behavior:
  - `ccp list` — table: name, dir, auth, account, #mcp, launcher. Reads live discovery, merges manifest if present (marks profiles not yet adopted with `*`).
  - `ccp adopt [--yes]` — discover, `buildManifest`, print summary (profiles + mcp counts), write via `saveManifest` (init git repo in manifestRoot first if absent: `git init`). Without `--yes`, print what would be written and require confirmation via `--yes` (v1: non-interactive flag, no prompt lib).
  - `ccp doctor` — checks: broken symlinks in profile dirs; rc file contains raw `sk-ant-` outside the managed block (plaintext secret warning); profiles in manifest missing on disk. Prints findings, exits 1 if any error-level finding.

- [ ] **Step 1: Write failing tests**

`packages/cli/test/cli.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-cli-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
})

describe('ccp list', () => {
  it('shows discovered profiles', async () => {
    const out = await run('list')
    expect(out).toContain('default')
    expect(out).toContain('a@b.c')
  })
})

describe('ccp adopt', () => {
  it('writes manifest with --yes', async () => {
    await run('adopt', '--yes')
    expect(existsSync(join(home, '.ccprofiles', 'manifest.yaml'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/cli/src/context.ts`:
```ts
import { Command } from 'commander'
import { detectPlatform, type Platform } from '@ccprofiles/core'
import { join } from 'node:path'
import { registerProfileCommands } from './commands/profiles.js'

export interface CliContext {
  home: string
  platform: Platform
  manifestRoot: string
  secretsIndexPath: string
  secretsFilePath: string
  backupRoot: string
}

export function makeContext(env: NodeJS.ProcessEnv = process.env): CliContext {
  const testHome = env.CCPROFILES_TEST_HOME
  const platform = detectPlatform(testHome ? { home: testHome } : {})
  const manifestRoot = env.CCPROFILES_HOME ?? join(platform.home, '.ccprofiles')
  return {
    home: platform.home,
    platform,
    manifestRoot,
    secretsIndexPath: join(manifestRoot, 'secret-names.json'),
    secretsFilePath: join(manifestRoot, 'secrets.enc'),
    backupRoot: join(manifestRoot, 'backups'),
  }
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('ccp').description('Claude Code profile manager')
  program.exitOverride() // throw instead of process.exit — required for tests
  registerProfileCommands(program, ctx)
  return program
}
```

`packages/cli/src/commands/profiles.ts`:
```ts
import type { Command } from 'commander'
import { discoverProfiles, buildManifest, saveManifest, loadManifest } from '@ccprofiles/core'
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CliContext } from '../context.js'

export function registerProfileCommands(program: Command, ctx: CliContext): void {
  program.command('list').description('list Claude Code profiles').action(async () => {
    const live = await discoverProfiles(ctx.home)
    const rows = live.map(lp => ({
      name: lp.dirName === '.claude' ? 'default' : lp.dirName.slice('.claude-'.length),
      dir: lp.dir,
      account: lp.account ?? '-',
      mcp: Object.keys(lp.mcpServers).length,
    }))
    for (const r of rows) console.log(`${r.name.padEnd(12)} ${String(r.mcp).padStart(3)} mcp  ${r.account.padEnd(28)} ${r.dir}`)
  })

  program.command('adopt').description('build manifest from live profiles')
    .option('--yes', 'write without confirmation')
    .action(async (opts: { yes?: boolean }) => {
      const live = await discoverProfiles(ctx.home)
      const manifest = buildManifest(live, ctx.platform)
      console.log(`Discovered ${manifest.profiles.length} profiles, ${Object.keys(manifest.mcpServers).length} mcp servers.`)
      if (!opts.yes) { console.log('Re-run with --yes to write the manifest.'); return }
      if (!existsSync(join(ctx.manifestRoot, '.git'))) {
        try { execFileSync('git', ['init', ctx.manifestRoot], { stdio: 'ignore' }) } catch { /* git optional */ }
      }
      await saveManifest(ctx.manifestRoot, manifest)
      console.log(`Manifest written to ${join(ctx.manifestRoot, 'manifest.yaml')}`)
    })

  program.command('doctor').description('check setup health').action(async () => {
    const problems: string[] = []
    const live = await discoverProfiles(ctx.home)
    for (const lp of live)
      for (const name of readdirSync(lp.dir)) {
        const f = join(lp.dir, name)
        try {
          if (lstatSync(f).isSymbolicLink() && !existsSync(f)) problems.push(`broken symlink: ${f} -> ${readlinkSync(f)}`)
        } catch { /* ignore */ }
      }
    if (existsSync(ctx.platform.rcFile)) {
      const rc = readFileSync(ctx.platform.rcFile, 'utf8')
      const outsideBlock = rc.split('# >>> ccprofiles managed >>>')[0] + (rc.split('# <<< ccprofiles managed <<<')[1] ?? '')
      if (/sk-ant-/.test(outsideBlock)) problems.push(`plaintext Anthropic key found in ${ctx.platform.rcFile} — run: ccp secrets migrate`)
    }
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const m = await loadManifest(ctx.manifestRoot)
      for (const pr of m.profiles) {
        const dir = pr.dir.replace('{home}', ctx.home)
        if (!existsSync(dir)) problems.push(`manifest profile "${pr.name}" missing on disk: ${dir} — run: ccp apply`)
      }
    }
    if (problems.length === 0) { console.log('ok: no problems found'); return }
    for (const p of problems) console.log(`warn: ${p}`)
    process.exitCode = 1
  })
}
```

`packages/cli/src/index.ts`:
```ts
#!/usr/bin/env node
import { buildProgram, makeContext } from './context.js'

buildProgram(makeContext()).parseAsync(process.argv).catch((e: Error) => {
  if ((e as any).code?.startsWith?.('commander.')) process.exit(1)
  console.error(`error: ${e.message}`)
  process.exit(1)
})
```

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): list, adopt, doctor commands"`

---

### Task 11: CLI — `mcp list/add/rm/sync`

**Files:**
- Create: `packages/cli/src/commands/mcp.ts`
- Modify: `packages/cli/src/context.ts` (register)
- Test: `packages/cli/test/mcp.test.ts`

**Interfaces:**
- Consumes: `loadManifest`, `saveManifest`, `discoverProfiles`, `planApply`, `executeApply`.
- Produces: commander subcommands under `ccp mcp`. All mutations edit the **manifest** then immediately run plan+execute (manifest is source of truth; live follows). All support `--dry-run`.
- Behavior:
  - `ccp mcp list` — matrix: rows = server names (union), columns = profiles, cell `x`/`.`. Flags drift visually.
  - `ccp mcp add <name> --profile <p>|--all [--command <cmd>] [--args <csv>]` — if server unknown in manifest, `--command` required; adds def + appends name to targeted profiles' `mcp`.
  - `ccp mcp rm <name> --profile <p>|--all` — removes from targeted profiles; drops def entirely when no profile references it.
  - `ccp mcp sync --from <p> --to <p1,p2>|--all` — sets each target's `mcp` list to a copy of source's.
  - Common epilogue helper `applyNow(ctx, dryRun)`: `planApply(manifest, await discoverProfiles(home), platform)` → `executeApply(..., { dryRun })` → print performed lines.
- Stamp for backups: `new Date().toISOString().replace(/[:.]/g, '-')`.

- [ ] **Step 1: Write failing tests**

`packages/cli/test/mcp.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-mcp-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  await mkdir(join(home, '.claude-work'))
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {} }))
  await run('adopt', '--yes')
})

describe('ccp mcp', () => {
  it('list shows drift matrix', async () => {
    const out = await run('mcp', 'list')
    expect(out).toContain('playwright')
    expect(out).toMatch(/x/)
    expect(out).toMatch(/\./)
  })
  it('add to all profiles updates live configs', async () => {
    await run('mcp', 'add', 'shadcn', '--all', '--command', 'npx', '--args', 'shadcn@latest,mcp')
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(cfg.mcpServers.shadcn.args).toEqual(['shadcn@latest', 'mcp'])
  })
  it('sync copies mcp set between profiles', async () => {
    await run('mcp', 'sync', '--from', 'default', '--to', 'work')
    const cfg = JSON.parse(await readFile(join(home, '.claude-work', '.claude.json'), 'utf8'))
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
  })
  it('rm drops def when unreferenced', async () => {
    await run('mcp', 'rm', 'playwright', '--all')
    const manifest = await readFile(join(home, '.ccprofiles', 'manifest.yaml'), 'utf8')
    expect(manifest).not.toContain('playwright')
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/cli/src/commands/mcp.ts`:
```ts
import type { Command } from 'commander'
import {
  discoverProfiles, loadManifest, saveManifest, planApply, executeApply, type Manifest,
} from '@ccprofiles/core'
import type { CliContext } from '../context.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

async function applyNow(ctx: CliContext, m: Manifest, dryRun: boolean): Promise<void> {
  const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
  const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun })
  for (const line of res.performed) console.log(`${dryRun ? '[dry-run] ' : ''}${line}`)
}

function targets(m: Manifest, opts: { profile?: string; all?: boolean }): string[] {
  if (opts.all) return m.profiles.map(p => p.name)
  if (!opts.profile) throw new Error('specify --profile <name> or --all')
  if (!m.profiles.some(p => p.name === opts.profile)) throw new Error(`unknown profile: ${opts.profile}`)
  return [opts.profile]
}

export function registerMcpCommands(program: Command, ctx: CliContext): void {
  const mcp = program.command('mcp').description('manage MCP servers across profiles')

  mcp.command('list').action(async () => {
    const m = await loadManifest(ctx.manifestRoot)
    const names = Object.keys(m.mcpServers).sort()
    const header = ' '.repeat(24) + m.profiles.map(p => p.name.padEnd(10)).join('')
    console.log(header)
    for (const n of names) {
      const cells = m.profiles.map(p => (p.mcp.includes(n) ? 'x' : '.').padEnd(10)).join('')
      console.log(n.padEnd(24) + cells)
    }
  })

  mcp.command('add <name>')
    .option('--profile <p>').option('--all').option('--dry-run')
    .option('--command <cmd>').option('--args <csv>')
    .action(async (name: string, opts: any) => {
      const m = await loadManifest(ctx.manifestRoot)
      if (!m.mcpServers[name]) {
        if (!opts.command) throw new Error(`unknown server "${name}" — pass --command (and optionally --args) to define it`)
        m.mcpServers[name] = { command: opts.command, ...(opts.args ? { args: String(opts.args).split(',') } : {}) }
      }
      for (const t of targets(m, opts)) {
        const pr = m.profiles.find(p => p.name === t)!
        if (!pr.mcp.includes(name)) pr.mcp.push(name)
      }
      if (!opts.dryRun) await saveManifest(ctx.manifestRoot, m)
      await applyNow(ctx, m, !!opts.dryRun)
    })

  mcp.command('rm <name>')
    .option('--profile <p>').option('--all').option('--dry-run')
    .action(async (name: string, opts: any) => {
      const m = await loadManifest(ctx.manifestRoot)
      for (const t of targets(m, opts)) {
        const pr = m.profiles.find(p => p.name === t)!
        pr.mcp = pr.mcp.filter(x => x !== name)
      }
      if (!m.profiles.some(p => p.mcp.includes(name))) delete m.mcpServers[name]
      if (!opts.dryRun) await saveManifest(ctx.manifestRoot, m)
      await applyNow(ctx, m, !!opts.dryRun)
    })

  mcp.command('sync')
    .requiredOption('--from <p>').option('--to <csv>').option('--all').option('--dry-run')
    .action(async (opts: any) => {
      const m = await loadManifest(ctx.manifestRoot)
      const src = m.profiles.find(p => p.name === opts.from)
      if (!src) throw new Error(`unknown profile: ${opts.from}`)
      const to = opts.all
        ? m.profiles.filter(p => p.name !== src.name).map(p => p.name)
        : String(opts.to ?? '').split(',').filter(Boolean)
      if (to.length === 0) throw new Error('specify --to <p1,p2> or --all')
      for (const t of to) {
        const pr = m.profiles.find(p => p.name === t)
        if (!pr) throw new Error(`unknown profile: ${t}`)
        pr.mcp = [...src.mcp]
      }
      if (!opts.dryRun) await saveManifest(ctx.manifestRoot, m)
      await applyNow(ctx, m, !!opts.dryRun)
    })
}
```

In `context.ts`, add `registerMcpCommands(program, ctx)` after `registerProfileCommands`.

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): mcp list/add/rm/sync with drift matrix"`

---

### Task 12: CLI — `secrets set/get/list/rm/migrate`

**Files:**
- Create: `packages/cli/src/commands/secrets.ts`
- Modify: `packages/cli/src/context.ts` (register + `secretsStore(ctx)` factory)
- Test: `packages/cli/test/secrets.test.ts`

**Interfaces:**
- Consumes: `SecretsStore`, `FileBackend`, `defaultBackend`, `upsertManagedBlock`, `backupFiles`, `atomicWrite`.
- Produces: `ccp secrets set <name> [value]` (value arg or `--stdin`), `get <name>` (prints raw value, exit 1 if missing), `list` (names + backend name), `rm <name>`, `migrate [--dry-run]`.
- Backend selection: `CCPROFILES_PASSPHRASE` env forces FileBackend with that passphrase (also the test hook). Otherwise `defaultBackend(platform, …)`; FileBackend passphrase read from `CCPROFILES_PASSPHRASE` or error asking user to set it (no interactive prompt in v1).
- Migrate rules: scan rc file for lines matching `(export\s+)?(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)\s*=\s*"?(sk-[A-Za-z0-9_-]+)"?` outside the managed block. For each: store secret under kebab-cased var name (`anthropic-api-key`), replace the value in-line with `"$(ccp secrets get <name>)"`, back up rc first. Print summary of migrated names.

- [ ] **Step 1: Write failing tests**

`packages/cli/test/secrets.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'test-pw', SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ccp-sec-')) })

describe('ccp secrets', () => {
  it('set/get/list/rm round-trip', async () => {
    await run('secrets', 'set', 'api-key', 'sk-ant-xyz')
    expect(await run('secrets', 'get', 'api-key')).toBe('sk-ant-xyz')
    expect(await run('secrets', 'list')).toContain('api-key')
    await run('secrets', 'rm', 'api-key')
    expect(await run('secrets', 'list')).not.toContain('api-key')
  })
  it('migrate moves plaintext keys out of rc', async () => {
    const rc = join(home, '.zshrc')
    await writeFile(rc, 'export ANTHROPIC_API_KEY="sk-ant-api03-SECRET"\nalias x=y\n')
    const out = await run('secrets', 'migrate')
    expect(out).toContain('anthropic-api-key')
    const after = await readFile(rc, 'utf8')
    expect(after).not.toContain('sk-ant-api03-SECRET')
    expect(after).toContain('$(ccp secrets get anthropic-api-key)')
    expect(after).toContain('alias x=y')
    expect(await run('secrets', 'get', 'anthropic-api-key')).toBe('sk-ant-api03-SECRET')
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/cli/src/commands/secrets.ts`:
```ts
import type { Command } from 'commander'
import { SecretsStore, FileBackend, defaultBackend, backupFiles, atomicWrite } from '@ccprofiles/core'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { CliContext } from '../context.js'

export async function secretsStore(ctx: CliContext, env: NodeJS.ProcessEnv = process.env): Promise<SecretsStore> {
  const pw = env.CCPROFILES_PASSPHRASE
  const backend = pw
    ? new FileBackend(ctx.secretsFilePath, pw)
    : await defaultBackend(ctx.platform, {
        filePath: ctx.secretsFilePath,
        passphrase: async () => { throw new Error('set CCPROFILES_PASSPHRASE for the encrypted-file backend') },
      })
  return new SecretsStore(backend, ctx.secretsIndexPath)
}

const KEY_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
const MIGRATE_RE = new RegExp(`^(\\s*(?:export\\s+)?(${KEY_VARS.join('|')})\\s*=\\s*)"?(sk-[A-Za-z0-9_-]+)"?(.*)$`)

export function registerSecretsCommands(program: Command, ctx: CliContext, env: NodeJS.ProcessEnv = process.env): void {
  const sec = program.command('secrets').description('manage secrets (values never stored in configs)')

  sec.command('set <name> [value]').action(async (name: string, value?: string) => {
    if (value === undefined) throw new Error('value required (interactive prompt lands in Plan 2)')
    const store = await secretsStore(ctx, env)
    await store.set(name, value)
    console.log(`stored ${name} (${store.backendName})`)
  })

  sec.command('get <name>').action(async (name: string) => {
    const store = await secretsStore(ctx, env)
    const v = await store.get(name)
    if (v === null) { process.exitCode = 1; return }
    console.log(v)
  })

  sec.command('list').action(async () => {
    const store = await secretsStore(ctx, env)
    for (const n of await store.list()) console.log(`${n}  (${store.backendName})`)
  })

  sec.command('rm <name>').action(async (name: string) => {
    const store = await secretsStore(ctx, env)
    await store.delete(name)
    console.log(`removed ${name}`)
  })

  sec.command('migrate').option('--dry-run').action(async (opts: { dryRun?: boolean }) => {
    const rcFile = ctx.platform.rcFile
    if (!existsSync(rcFile)) { console.log('no rc file found'); return }
    const store = await secretsStore(ctx, env)
    const lines = (await readFile(rcFile, 'utf8')).split('\n')
    const migrated: string[] = []
    const out = [] as string[]
    for (const line of lines) {
      const match = line.match(MIGRATE_RE)
      if (!match) { out.push(line); continue }
      const [, prefix, varName, secretValue, suffix] = match
      const secretName = varName.toLowerCase().replaceAll('_', '-')
      if (!opts.dryRun) await store.set(secretName, secretValue)
      out.push(`${prefix}"$(ccp secrets get ${secretName})"${suffix}`)
      migrated.push(secretName)
    }
    if (migrated.length === 0) { console.log('no plaintext keys found'); return }
    if (!opts.dryRun) {
      await backupFiles([rcFile], ctx.backupRoot, new Date().toISOString().replace(/[:.]/g, '-'))
      await atomicWrite(rcFile, out.join('\n'))
    }
    for (const n of migrated) console.log(`${opts.dryRun ? '[dry-run] ' : ''}migrated ${n}`)
  })
}
```

In `context.ts`: register with the same env used by `makeContext` (pass env through — change `makeContext` to also stash `env` on the context, or register as `registerSecretsCommands(program, ctx, env)`; pick the latter and thread `env` from `makeContext`'s caller by storing it: add `env: NodeJS.ProcessEnv` field to `CliContext`).

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): secrets set/get/list/rm + rc migrate"`

---

### Task 13: CLI — `status` / `apply` / `snapshot` + `create`

**Files:**
- Create: `packages/cli/src/commands/manifest.ts`
- Modify: `packages/cli/src/context.ts` (register)
- Test: `packages/cli/test/manifest-cmd.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `ccp status` — runs `planApply`, prints pending action descriptions or `in sync`.
  - `ccp apply [--dry-run]` — plan + execute with backups; prints performed + backup dir.
  - `ccp snapshot` — re-runs `buildManifest` from live and overwrites manifest (live → manifest, the inverse of apply). Prints diff summary of profile/mcp counts.
  - `ccp create <name> [--from <profile>]` — appends a new profile to the manifest: dir `{home}/.claude-<name>`, launcher `cl-<name>`, auth `env`, links/mcp copied from `--from` profile (or hub links + empty mcp), then apply. Errors if name exists.

- [ ] **Step 1: Write failing tests**

`packages/cli/test/manifest-cmd.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-man-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
  await run('adopt', '--yes')
  await run('apply')
})

describe('status/apply/create', () => {
  it('status reports in sync after apply', async () => {
    expect(await run('status')).toContain('in sync')
  })
  it('create scaffolds a new profile and launcher', async () => {
    await run('create', 'work', '--from', 'default')
    expect(existsSync(join(home, '.claude-work', '.claude.json'))).toBe(true)
    const rc = await import('node:fs/promises').then(fs => fs.readFile(join(home, '.zshrc'), 'utf8'))
    expect(rc).toContain('cl-work()')
    const cfg = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(home, '.claude-work', '.claude.json'), 'utf8')))
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright'])
  })
})
```

- [ ] **Step 2: Run to verify fail** → FAIL
- [ ] **Step 3: Implement**

`packages/cli/src/commands/manifest.ts`:
```ts
import type { Command } from 'commander'
import {
  discoverProfiles, buildManifest, loadManifest, saveManifest, planApply, executeApply,
} from '@ccprofiles/core'
import type { CliContext } from '../context.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerManifestCommands(program: Command, ctx: CliContext): void {
  program.command('status').description('show live-vs-manifest drift').action(async () => {
    const m = await loadManifest(ctx.manifestRoot)
    const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
    if (actions.length === 0) { console.log('in sync'); return }
    const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: true })
    for (const line of res.performed) console.log(`pending: ${line}`)
  })

  program.command('apply').description('apply manifest to live configs')
    .option('--dry-run')
    .action(async (opts: { dryRun?: boolean }) => {
      const m = await loadManifest(ctx.manifestRoot)
      const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
      if (actions.length === 0) { console.log('in sync — nothing to do'); return }
      const res = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!opts.dryRun })
      for (const line of res.performed) console.log(`${opts.dryRun ? '[dry-run] ' : ''}${line}`)
      if (res.backupDir) console.log(`backups: ${res.backupDir}`)
    })

  program.command('snapshot').description('overwrite manifest from live state').action(async () => {
    const m = buildManifest(await discoverProfiles(ctx.home), ctx.platform)
    await saveManifest(ctx.manifestRoot, m)
    console.log(`snapshot: ${m.profiles.length} profiles, ${Object.keys(m.mcpServers).length} mcp servers`)
  })

  program.command('create <name>').description('create a new profile')
    .option('--from <profile>', 'copy mcp list and links from an existing profile')
    .action(async (name: string, opts: { from?: string }) => {
      const m = await loadManifest(ctx.manifestRoot)
      if (m.profiles.some(p => p.name === name)) throw new Error(`profile exists: ${name}`)
      const src = opts.from ? m.profiles.find(p => p.name === opts.from) : null
      if (opts.from && !src) throw new Error(`unknown profile: ${opts.from}`)
      m.profiles.push({
        name,
        dir: `{home}/.claude-${name}`,
        launcher: `cl-${name}`,
        auth: 'env',
        env: {},
        links: src ? { ...src.links } : (m.hub ? { skills: 'hub', commands: 'hub' } : {}),
        mcp: src ? [...src.mcp] : [],
      })
      await saveManifest(ctx.manifestRoot, m)
      const actions = planApply(m, await discoverProfiles(ctx.home), ctx.platform)
      await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
      console.log(`profile "${name}" created — launcher: cl-${name} (restart your shell)`)
    })
}
```

Register in `context.ts`.

- [ ] **Step 4: Run to verify pass** → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): status, apply, snapshot, create"`

---

### Task 14: End-to-end smoke test against a realistic fixture home

**Files:**
- Create: `packages/cli/test/e2e.test.ts`

**Interfaces:** consumes the full CLI surface; guards the whole pipeline.

- [ ] **Step 1: Write the test** (this is a verification task — test is expected to pass if Tasks 1–13 are correct; failures here are integration bugs to fix on the spot)

`packages/cli/test/e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, makeContext } from '../src/context.js'

let home: string
async function run(...args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  const ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
  await buildProgram(ctx).parseAsync(['node', 'ccp', ...args])
  spy.mockRestore()
  return lines.join('\n')
}

beforeAll(async () => {
  // realistic 3-profile fixture mirroring the motivating setup
  home = await mkdtemp(join(tmpdir(), 'ccp-e2e-'))
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await mkdir(join(home, '.claude', 'commands'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, obsidian: { command: 'uvx', args: ['mcp-obsidian'] } },
    oauthAccount: { emailAddress: 'me@personal.com' },
  }))
  await mkdir(join(home, '.claude-office'))
  await writeFile(join(home, '.claude-office', '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    oauthAccount: { emailAddress: 'me@office.co' },
  }))
  await writeFile(join(home, '.zshrc'), 'export ANTHROPIC_API_KEY="sk-ant-api03-LEGACY"\n')
})

describe('e2e: adopt → migrate → mcp sync → apply → doctor', () => {
  it('full pipeline', async () => {
    await run('adopt', '--yes')
    expect(existsSync(join(home, '.ccprofiles', 'manifest.yaml'))).toBe(true)

    await run('secrets', 'migrate')
    expect(await readFile(join(home, '.zshrc'), 'utf8')).not.toContain('sk-ant-api03-LEGACY')

    await run('mcp', 'sync', '--from', 'default', '--to', 'office')
    const office = JSON.parse(await readFile(join(home, '.claude-office', '.claude.json'), 'utf8'))
    expect(Object.keys(office.mcpServers).sort()).toEqual(['obsidian', 'playwright'])

    await run('apply')
    expect(await run('status')).toContain('in sync')

    const doctorOut = await run('doctor')
    expect(doctorOut).toContain('ok')
  })
})
```

- [ ] **Step 2: Run full suite** — `npm test` → all green. Fix any integration bugs surfaced (each fix gets its own commit).
- [ ] **Step 3: Commit** — `git commit -am "test: end-to-end pipeline smoke test"`

---

## Self-Review Notes

- **Spec coverage (Plan 1 scope):** profiles list/create/adopt ✔ (T10, T13), doctor ✔ (T10), MCP manage+sync ✔ (T11), secrets + migrate ✔ (T8, T12), apply/status/snapshot with backups+dry-run ✔ (T9, T13), platform adapters ✔ (T2, T6). LAN sync, bundle, packaging → Plan 2 by design.
- **Type consistency:** `LiveProfile`, `Manifest`, `ApplyAction`, `CliContext` signatures are used verbatim across tasks; `buildProgram`/`makeContext` names match in all CLI tests.
- **Known intentional gaps (v1):** no interactive prompts (flags/env only), `secrets set` takes value as arg (shell-history caveat documented in Plan 2's README task), Windows DPAPI backend deferred to Plan 2 (FileBackend fallback works everywhere).
