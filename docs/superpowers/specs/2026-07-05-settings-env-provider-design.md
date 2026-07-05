# Per-profile provider config: `settingsEnv` managed into settings.json

**Date:** 2026-07-05
**Status:** Approved

## Goal

Profiles that run Claude Code against a different LLM provider (e.g. `.claude-z` →
z.ai GLM) keep their provider config — `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
model-mapping vars, timeouts — in `<profile-dir>/settings.json` under `env`. Today
clp is blind to that file: not adopted, not editable, not synced, token in plaintext
with no keychain backing. Make it a first-class managed surface.

## Scope decisions (user-confirmed)

- **Model:** generic `settingsEnv: Record<string,string>` per profile (option A) —
  no provider-specific schema. Any env key can be managed; base URL/token/models are
  just entries.
- **Token storage:** manifest stores `secret://<name>`; real value in the keychain;
  apply resolves and writes the plaintext value into settings.json (Claude Code must
  be able to read it). Keychain is the source of truth; LAN sync uses the existing
  encrypted secrets channel.

## Manifest (`packages/core/src/manifest.ts`)

- `ProfileSchema` gains `settingsEnv: z.record(z.string()).default({})`.
- `assertSafeManifest`: `settingsEnv` keys must match `SAFE_ENV_KEY`; values starting
  with `secret://` must have a `SAFE_NAME` ref (non-empty). Other values are freeform
  (they land in JSON, not shell — no shell-meta restrictions).
- Backward compat: old manifests parse fine (default `{}`). Old peer versions
  receiving a new manifest strip the unknown key silently — acceptable; documented.

## Discovery & adopt

- `LiveProfile` gains `settingsEnv: Record<string,string>` — read from
  `<dir>/settings.json` `.env` (missing file/key/invalid JSON → `{}`; non-string
  values are skipped).
- `buildManifest` imports it verbatim as the profile's `settingsEnv`.

## Apply (`packages/core/src/apply.ts`)

- New action: `{ kind: 'set-settings-env'; settingsPath: string; env: Record<string,string> }`.
- Semantics follow the `set-mcp-servers` precedent: when a profile's `settingsEnv`
  is **non-empty**, clp owns the whole `env` object in that profile's settings.json —
  desired = fully resolved `settingsEnv`. When empty, the file is left completely
  alone (no action ever planned).
- All other settings.json keys (hooks, plugins, model, permissions, …) are preserved:
  executeApply reads the existing JSON (missing file → `{}`), replaces only `.env`,
  writes back via `atomicWrite`; the file is included in the backup set.
- **Secret resolution** happens before planning: new core helper
  `resolveSettingsEnv(m: Manifest, getSecret: (name: string) => Promise<string | null>): Promise<Record<string, Record<string,string>>>`
  (profile name → resolved env). A `secret://` ref whose secret is missing throws
  `Error("profile \"<name>\": secret not found: <ref> (for <KEY>)")` — hard error,
  no partial apply.
- `planApply` gains an optional 4th arg `resolved?: Record<string, Record<string,string>>`;
  when a profile has non-empty `settingsEnv`, its resolved env is compared
  (key-sorted JSON) against the live settings.json env and an action planned on
  mismatch. Callers that mutate/apply (CLI apply/profile/mcp/sync commands, UI API
  `applyAndReport`, UI sync route) all pass the resolved map; `status`/dry-run paths
  do too, so drift is visible.

## Secrets migrate & doctor

- `secrets migrate` (CLI + UI endpoint) extends to settings.json: for each manifest
  profile whose `settingsEnv` has a key in `KEY_VARS` (`ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`) with a value not already
  `secret://…`, store the value in the keychain as `<var-kebab>-<profile>` (e.g.
  `anthropic-auth-token-z`), flip the manifest entry to `secret://<that-name>`, save,
  apply. Reported alongside rc migrations.
- `doctor`: flags values in a profile's **live** settings.json env that look like
  tokens (key in `KEY_VARS`) when the profile has no matching manifest-managed
  `settingsEnv` entry — i.e. plaintext tokens clp isn't managing.

## Sync

No protocol changes. Manifest replicates `settingsEnv` (secret refs only — safe);
secret values travel via the existing encrypted secrets channel; apply on the peer
resolves and rebuilds its settings.json.

## UI / API

- `GET /api/profiles` rows include `settingsEnv` (from manifest; `{}` unadopted).
- `PATCH /api/profiles/:name` accepts `settingsEnv` (values must be strings — 400
  otherwise; `assertSafeManifest` runs before save as everywhere).
- Profile editor gains a second section **"Provider settings (settings.json env)"**
  using the same key/value/secret-picker row editor as launcher env.
- Profiles table gains a **Provider** column: hostname of `ANTHROPIC_BASE_URL` from
  `settingsEnv` (e.g. `api.z.ai`), `—` when unset (= Anthropic default).

## CLI

Covered by existing surfaces: adopt imports, `apply` applies, `secrets migrate`
migrates, and the UI edits. No new subcommand in this iteration (YAGNI — revisit if
editing from the terminal is actually wanted).

## Acceptance example (the user's real shape)

A profile `z` with settings.json env
`{ ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL }`:
adopt imports all 7 keys; migrate moves the token to keychain as
`anthropic-auth-token-z` and flips the manifest ref; apply round-trips settings.json
byte-stable except managed `.env`; UI shows `api.z.ai` in the Provider column and
edits any of the 7 keys; doctor is quiet (token is managed).

## Testing

- core: manifest schema + validation (bad key, empty secret ref), discovery reads
  settings.json env, adopt import, `resolveSettingsEnv` (plain/secret/missing-secret),
  planApply diff + executeApply merge preserving unmanaged settings.json keys,
  backup inclusion.
- cli: PATCH/GET `settingsEnv` via UI API, migrate flips manifest + stores secret
  (fake backend), doctor flags unmanaged plaintext token.
- e2e (sandboxed verify skill): the acceptance example above end-to-end.

## Out of scope

- Provider presets / named provider registry.
- apiKeyHelper integration.
- Managing settings.json keys other than `env`.
- New CLI subcommands.
