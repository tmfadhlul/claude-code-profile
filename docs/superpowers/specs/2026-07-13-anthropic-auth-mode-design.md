# Anthropic provider auth-mode setup via clp — design

Date: 2026-07-13
Status: Approved (design), pending implementation plan

## Problem

For the Anthropic provider there's no clear way to choose HOW a profile
authenticates. Custom providers (z.ai / mimo / OpenRouter) are configured via
the existing `ProviderForm` (base URL + token → `settingsEnv`), but for the
plain Anthropic endpoint the only obvious path is "leave it empty and run
`claude login`". Users want to set an **API key** or an **auth token** for the
Anthropic endpoint directly via `clp`, instead of the interactive CLI login.

## Goal

Let a user pick, per claude profile, one of three Anthropic auth modes —
**CLI login**, **API key**, **auth token** — from both the CLI and the
dashboard. Config-only: `clp` writes the config; it never launches the
interactive login.

## Decisions (from brainstorming)

- **Config-only.** `login` clears the token env; `api-key`/`auth-token` write
  the corresponding var. clp never spawns `claude login`.
- **Both surfaces.** A `clp provider` CLI command AND a 3-way selector in the
  dashboard Provider section.
- **No new schema field.** The mode is derived from `settingsEnv`.

## Model

Anthropic auth mode is derived from a claude profile's `settingsEnv`, and only
meaningful when the base URL is Anthropic-default (`ANTHROPIC_BASE_URL` unset):

- `ANTHROPIC_API_KEY` present → `api-key`
- `ANTHROPIC_AUTH_TOKEN` present (and no custom `ANTHROPIC_BASE_URL`) → `auth-token`
- neither → `login`

A custom `ANTHROPIC_BASE_URL` means a non-Anthropic provider; the auth-mode
selector does not apply there (that remains the existing ProviderForm flow).

## Core helpers (new `packages/core/src/provider.ts`, pure)

Shared source of truth for CLI + UI:

```ts
export type AnthropicAuthMode = 'login' | 'api-key' | 'auth-token'
const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** Derive the current Anthropic auth mode from a settingsEnv map. */
export function anthropicAuthMode(env: Record<string, string>): AnthropicAuthMode

/**
 * Return a new settingsEnv with the chosen mode applied. All non-auth keys
 * (models, timeout, etc.) preserved. `login` removes both token vars;
 * `api-key`/`auth-token` set that var to tokenRef and remove the other var.
 * Throws if env has a custom ANTHROPIC_BASE_URL (that's a non-Anthropic provider).
 * tokenRef is the value to store (typically `secret://<name>`); required for
 * the two token modes, ignored for `login`.
 */
export function setAnthropicAuthMode(
  env: Record<string, string>,
  mode: AnthropicAuthMode,
  tokenRef?: string,
): Record<string, string>
```

Exported from `packages/core/src/index.ts`.

## CLI: `clp provider`

New command group in a new `packages/cli/src/commands/provider.ts`, registered
in `context.ts`.

- `clp provider list` — table: each claude profile → current Anthropic auth
  mode (login / api-key / auth-token). Codex profiles omitted or shown as `-`.
- `clp provider anthropic <profile> --login` — set mode `login` (clears both
  token vars from the profile's `settingsEnv`), save manifest, apply.
- `clp provider anthropic <profile> --api-key [--secret <name>]` — set mode
  `api-key`. If `--secret <name>` given, reference that existing secret; else
  prompt for the key with the **masked no-echo reader** (the injectable
  `ctx.promptSecret` from the secrets-set fix — never in argv), store it as a
  keychain secret named `anthropic-api-key-<profile>`, and set
  `ANTHROPIC_API_KEY = secret://<name>`. Save manifest, apply.
- `clp provider anthropic <profile> --auth-token [--secret <name>]` — mirrors
  `--api-key` with `ANTHROPIC_AUTH_TOKEN` / secret `anthropic-auth-token-<profile>`.
- Exactly one of `--login` / `--api-key` / `--auth-token` required.
- A codex profile target → clear error ("Anthropic auth applies to Claude
  profiles only").
- A profile with a custom `ANTHROPIC_BASE_URL` → clear error ("profile <p> uses
  a custom provider base URL — manage its token in the Provider editor").

Apply writes the profile's `settings.json` via the existing apply path
(`set-settings-env`), resolving the `secret://` ref from the keychain.

## UI

Extend the Provider section (`packages/ui/src/lib/provider.ts` +
`packages/ui/src/components/ProviderForm.tsx`): when the selected provider is
Anthropic-default (no custom base URL), present a 3-way **Authentication**
selector — CLI login / API key / Auth token — replacing the current implicit
2-way tokenVar toggle for that case.

- `login` → hide the token field; show a hint ("Run `cl-<profile>` then
  `/login`, or `claude login`, to sign in.").
- `api-key` / `auth-token` → show the existing secret-backed token field,
  writing the corresponding var.

Saves through the existing `settingsEnv` PATCH (`PATCH /api/profiles/:name`) —
NO new API route. The mode is computed from the form state via the shared core
helper (or a thin UI mirror) so UI and CLI agree.

## Testing

- **core:** `anthropicAuthMode` derivation for each state; `setAnthropicAuthMode`
  transitions (login clears both; each token mode sets its var + removes the
  other; models/timeout/other keys preserved; throws on custom base URL).
- **cli:** `provider anthropic --login/--api-key/--auth-token` mutate the
  profile's `settingsEnv` correctly and save+apply once; masked prompt is used
  when no `--secret` (injected fake reader — no real TTY); `--secret <name>`
  references an existing secret; `provider list` shows the right mode; a codex
  target and a custom-base-URL profile both error.
- **ui:** provider.ts mode helper; `npm run build` type-checks; suite green.

## Edge cases / limitations

- Anthropic-only; Codex auth (`auth.json`) is out of scope (Codex has its own
  `cx login`).
- Config-only: never launches interactive login.
- If both token vars are somehow present (hand-edited), `anthropicAuthMode`
  prefers `api-key` (documented), and applying any mode normalizes to exactly
  one/zero token var.
- The token stays keychain-backed (`secret://`), so it never lands in argv,
  git history, or plaintext settings (consistent with the audit hardening).

## Out of scope (v1)

- Launching / tracking the interactive login flow.
- Codex auth-mode management.
- Validating a key against the Anthropic API before saving.
