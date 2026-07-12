# Anthropic Auth-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user set a claude profile's Anthropic auth mode — CLI login / API key / auth token — via `clp provider` (CLI) and the dashboard Provider section. Config-only (writes `settingsEnv`; never launches login). Token stays keychain-backed.

**Architecture:** Pure core helpers derive/set the mode from `settingsEnv` (no new schema field). A new `clp provider` command uses them + the masked-prompt secret seam. The UI ProviderForm gains a 3-way auth selector for the Anthropic-default case, saving via the existing settingsEnv PATCH.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Commander, React/Vite, Vitest.

## Global Constraints

- Mode ↔ settingsEnv: `ANTHROPIC_API_KEY` present → `api-key`; `ANTHROPIC_AUTH_TOKEN` present (no custom base URL) → `auth-token`; neither → `login`.
- `setAnthropicAuthMode` preserves all non-auth keys (models, timeout, base URL for the login/token cases — but THROWS if a custom `ANTHROPIC_BASE_URL` is present, since that's a non-Anthropic provider).
- Token value stored as a `secret://<name>` ref; the raw token NEVER appears in argv (use the masked `ctx.promptSecret` seam, default `readSecretMasked`).
- Anthropic auth is claude-only; codex profiles error.
- Commit EXPLICIT paths only (never `git add -A`; keep untracked AGENTS.md/CLAUDE.md/.claude + modified .gitignore unstaged).
- `npm run build` + `npx vitest run` green before each commit (suite currently 284).

---

### Task 1: Core provider helpers

**Files:** Create `packages/core/src/provider.ts`; Modify `packages/core/src/index.ts` (export); Test `packages/core/test/provider.test.ts`.

**Interfaces:**
- Produces: `type AnthropicAuthMode = 'login'|'api-key'|'auth-token'`; `anthropicAuthMode(env): AnthropicAuthMode`; `setAnthropicAuthMode(env, mode, tokenRef?): Record<string,string>`. Consumed by Tasks 2 (CLI) and 3 (UI).

- [ ] **Step 1: Write the failing test** — `packages/core/test/provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { anthropicAuthMode, setAnthropicAuthMode } from '../src/provider.js'

describe('anthropicAuthMode', () => {
  it('derives the mode from settingsEnv', () => {
    expect(anthropicAuthMode({})).toBe('login')
    expect(anthropicAuthMode({ ANTHROPIC_API_KEY: 'secret://k' })).toBe('api-key')
    expect(anthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: 'secret://t' })).toBe('auth-token')
    // both present (hand-edited) → prefer api-key
    expect(anthropicAuthMode({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b' })).toBe('api-key')
  })
})

describe('setAnthropicAuthMode', () => {
  it('login clears both token vars, keeps other keys', () => {
    const out = setAnthropicAuthMode({ ANTHROPIC_API_KEY: 'secret://k', ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' }, 'login')
    expect(out).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' })
  })
  it('api-key sets the key, removes auth-token, keeps other keys', () => {
    const out = setAnthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: 'secret://t', API_TIMEOUT_MS: '30000' }, 'api-key', 'secret://mykey')
    expect(out).toEqual({ ANTHROPIC_API_KEY: 'secret://mykey', API_TIMEOUT_MS: '30000' })
  })
  it('auth-token sets the token, removes api-key', () => {
    const out = setAnthropicAuthMode({ ANTHROPIC_API_KEY: 'secret://k' }, 'auth-token', 'secret://tok')
    expect(out).toEqual({ ANTHROPIC_AUTH_TOKEN: 'secret://tok' })
  })
  it('token modes require a tokenRef', () => {
    expect(() => setAnthropicAuthMode({}, 'api-key')).toThrow(/token/i)
  })
  it('throws when a custom base URL is present (non-Anthropic provider)', () => {
    expect(() => setAnthropicAuthMode({ ANTHROPIC_BASE_URL: 'https://z.ai' }, 'login')).toThrow(/base URL|custom provider/i)
  })
})
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run packages/core/test/provider.test.ts`.

- [ ] **Step 3: Create `packages/core/src/provider.ts`**:

```ts
export type AnthropicAuthMode = 'login' | 'api-key' | 'auth-token'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** Derive the current Anthropic auth mode from a settingsEnv map. */
export function anthropicAuthMode(env: Record<string, string>): AnthropicAuthMode {
  if (env[API_KEY] !== undefined) return 'api-key'
  if (env[AUTH_TOKEN] !== undefined) return 'auth-token'
  return 'login'
}

/**
 * New settingsEnv with `mode` applied. Non-auth keys preserved. `login` removes
 * both token vars; `api-key`/`auth-token` set that var to `tokenRef` and remove
 * the other. Throws if env has a custom ANTHROPIC_BASE_URL (non-Anthropic provider)
 * or if a token mode is chosen without a tokenRef.
 */
export function setAnthropicAuthMode(
  env: Record<string, string>,
  mode: AnthropicAuthMode,
  tokenRef?: string,
): Record<string, string> {
  if (env[BASE_URL] !== undefined && env[BASE_URL].trim())
    throw new Error(`profile uses a custom provider base URL (${env[BASE_URL]}) — manage its token in the Provider editor, not as an Anthropic auth mode`)
  const out = { ...env }
  delete out[API_KEY]
  delete out[AUTH_TOKEN]
  if (mode === 'login') return out
  if (!tokenRef || !tokenRef.trim()) throw new Error(`${mode} mode requires a token reference`)
  out[mode === 'api-key' ? API_KEY : AUTH_TOKEN] = tokenRef.trim()
  return out
}
```

- [ ] **Step 4: Export** — add `export * from './provider.js'` to `packages/core/src/index.ts` (match the barrel style).

- [ ] **Step 5: Run tests + build** — `npx vitest run packages/core/test/provider.test.ts && npm run build`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/provider.ts packages/core/src/index.ts packages/core/test/provider.test.ts
git commit -m "feat(core): Anthropic auth-mode derive/set helpers"
```

---

### Task 2: CLI `provider` command

**Files:** Create `packages/cli/src/commands/provider.ts`; Modify `packages/cli/src/context.ts` (register after another `register*`); Test `packages/cli/test/provider.test.ts`.

**Interfaces:**
- Consumes: `anthropicAuthMode`/`setAnthropicAuthMode` (core), `requireManifest`/`saveManifest`, `secretsStore`, `readSecretMasked`/`ctx.promptSecret`, `executeApply`+`planActions`.
- Produces: `registerProviderCommands(program, ctx)`; verbs `provider list`, `provider anthropic <profile> --login|--api-key|--auth-token [--secret <name>]`.

- [ ] **Step 1: Write the failing test** — `packages/cli/test/provider.test.ts` (follow `plugins.test.ts` for ctx/program + inject `promptSecret`):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'
import { loadManifest } from 'ccprofiles-core'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-provider-'))
  await mkdir(join(home, '.claude-work'), { recursive: true })
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {}, oauthAccount: { emailAddress: 'a@b.c' } }))
})
function run(promptValue: string | null, ...args: string[]): Promise<void> {
  const ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any),
    promptSecret: async () => promptValue ?? '' }
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('provider cli', () => {
  it('anthropic --api-key prompts for the key, stores a secret, sets settingsEnv', async () => {
    await run(null, 'adopt', '--yes')
    await run('sk-ant-TESTKEY', 'provider', 'anthropic', 'work', '--api-key')
    const m = await loadManifest(join(home, '.ccprofiles'))
    const pr = m.profiles.find(p => p.name === 'work')!
    expect(pr.settingsEnv.ANTHROPIC_API_KEY).toMatch(/^secret:\/\//)
    expect(pr.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
  it('anthropic --login clears both token vars', async () => {
    await run(null, 'adopt', '--yes')
    await run('sk-ant-X', 'provider', 'anthropic', 'work', '--auth-token')
    await run(null, 'provider', 'anthropic', 'work', '--login')
    const m = await loadManifest(join(home, '.ccprofiles'))
    const pr = m.profiles.find(p => p.name === 'work')!
    expect(pr.settingsEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(pr.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run packages/cli/test/provider.test.ts` (unknown command).

- [ ] **Step 3: Create `packages/cli/src/commands/provider.ts`**:

```ts
import type { Command } from 'commander'
import { anthropicAuthMode, setAnthropicAuthMode, executeApply, saveManifest, type AnthropicAuthMode } from 'ccprofiles-core'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'
import { secretsStore, readSecretMasked } from './secrets.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerProviderCommands(program: Command, ctx: CliContext): void {
  const provider = program.command('provider').description('manage a profile’s LLM provider auth')

  provider.command('list').description('show each Claude profile’s Anthropic auth mode').action(async () => {
    const m = await requireManifest(ctx)
    for (const p of m.profiles) {
      if ((p.agent ?? 'claude') !== 'claude') continue
      console.log(`${p.name.padEnd(16)} ${anthropicAuthMode(p.settingsEnv)}`)
    }
  })

  provider.command('anthropic <profile>')
    .description('set the Anthropic auth mode for a Claude profile')
    .option('--login', 'use interactive CLI login (clears any stored token)')
    .option('--api-key', 'authenticate with an Anthropic API key')
    .option('--auth-token', 'authenticate with an Anthropic auth token')
    .option('--secret <name>', 'reference an existing keychain secret instead of prompting')
    .action(async (name: string, opts: { login?: boolean; apiKey?: boolean; authToken?: boolean; secret?: string }) => {
      const chosen = [opts.login && 'login', opts.apiKey && 'api-key', opts.authToken && 'auth-token'].filter(Boolean)
      if (chosen.length !== 1) throw new Error('specify exactly one of --login, --api-key, --auth-token')
      const mode = chosen[0] as AnthropicAuthMode
      const m = await requireManifest(ctx)
      const pr = m.profiles.find(p => p.name === name)
      if (!pr) throw new Error(`unknown profile: ${name}`)
      if ((pr.agent ?? 'claude') !== 'claude') throw new Error(`Anthropic auth applies to Claude profiles only; "${name}" is a codex profile`)

      let tokenRef: string | undefined
      if (mode !== 'login') {
        const secretName = opts.secret ?? `anthropic-${mode}-${name}`
        if (!opts.secret) {
          const value = await (ctx.promptSecret ?? readSecretMasked)(`Anthropic ${mode === 'api-key' ? 'API key' : 'auth token'} for ${name}`)
          if (!value.trim()) throw new Error('no value entered')
          const store = await secretsStore(ctx)
          await store.set(secretName, value.trim())
        }
        tokenRef = `secret://${secretName}`
      }
      // setAnthropicAuthMode throws on a custom base URL — surface it
      pr.settingsEnv = setAnthropicAuthMode(pr.settingsEnv, mode, tokenRef)
      await saveManifest(ctx.manifestRoot, m)
      const actions = await planActions(ctx, m)
      const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
      for (const line of r.performed) console.log(line)
      console.log(`provider: ${name} → ${mode}`)
    })
}
```

(Verify `readSecretMasked` is exported from `commands/secrets.ts`; if not, export it or use `ctx.promptSecret ?? <the local masked reader>`.)

- [ ] **Step 4: Register** — import `registerProviderCommands` in `context.ts` and call it after `registerSessionCommands(program, ctx)` (or near the other config commands).

- [ ] **Step 5: Run tests + build + suite** — `npx vitest run packages/cli/test/provider.test.ts && npm run build && npx vitest run`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/provider.ts packages/cli/src/context.ts packages/cli/test/provider.test.ts
git commit -m "feat(cli): provider anthropic auth-mode command (login/api-key/auth-token)"
```

---

### Task 3: UI — 3-way Anthropic auth selector

**Files:** Modify `packages/ui/src/lib/provider.ts` (mode helper for the form), `packages/ui/src/components/ProviderForm.tsx` (the selector). Verify: `npm run build` + suite.

**Interfaces:** Consumes the shared core `anthropicAuthMode` concept; presents it in the form.

- [ ] **Step 1: Implement (UI — verify via build; no unit harness).**
  Read the current `ProviderForm.tsx` + `provider.ts` first. When the form's provider is **Anthropic-default** (base URL empty / preset `anthropic`), render an **Authentication** control with three choices — **CLI login**, **API key**, **Auth token** — replacing the implicit 2-way `tokenVar` toggle for that case:
  - Compute current mode: `login` if the token value is empty AND base URL empty; else `api-key`/`auth-token` from `tokenVar`.
  - **CLI login** selected → hide the token field; show a hint: "Run `cl-<profile>` then `/login` (or `claude login`) to sign in." On save, this maps to a `settingsEnv` with neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` (i.e. clear the token in the form → `mergeProviderEnv` already omits a blank token, so selecting login = clear the token value).
  - **API key** / **Auth token** selected → set `form.tokenVar` accordingly and show the existing secret-backed token field.
  - For a custom provider (non-Anthropic preset / custom base URL), keep the existing behavior unchanged (this selector only appears for Anthropic-default).
  Add a small helper in `packages/ui/src/lib/provider.ts` if it keeps the component clean, e.g. `providerAuthMode(form): 'login'|'api-key'|'auth-token'` mirroring the core logic (login when baseUrl empty && token empty).
- [ ] **Step 2: Verify** — `npm run build` type-checks clean; `npx vitest run` green. Reason through: selecting login then saving yields settingsEnv without the token vars; selecting API key with a secret yields `ANTHROPIC_API_KEY = secret://…`.
- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/provider.ts packages/ui/src/components/ProviderForm.tsx
git commit -m "feat(ui): 3-way Anthropic authentication selector in the provider editor"
```

---

## Verification (end of plan)

- [ ] `npm run build` clean; `npx vitest run` green (≥284 + new tests).
- [ ] Sandbox smoke per `.claude/skills/verify/SKILL.md`: `clp provider anthropic <profile> --api-key` (masked prompt) writes `ANTHROPIC_API_KEY = secret://…` into the profile's `settings.json` via apply; `clp provider list` shows the mode; `--login` clears it; a codex profile errors.

## Notes / limitations (from the spec)

- Anthropic-only, config-only (never launches login); Codex `auth.json` out of scope.
- Token stays keychain-backed (`secret://`) — never in argv/git/plaintext.
- Both-token-vars-present normalizes to one on any apply; `anthropicAuthMode` prefers `api-key`.
