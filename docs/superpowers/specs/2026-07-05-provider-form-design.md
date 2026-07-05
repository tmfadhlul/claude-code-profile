# Guided provider form in the profile editor

**Date:** 2026-07-05
**Status:** Approved

## Goal

Replace the raw "Provider settings (settings.json env)" key/value section in the UI
profile editor with a guided form (preset dropdown + labeled fields), so users don't
have to memorize Claude Code's env var names. Pure UI layer: manifest, API, and the
generic `settingsEnv` storage are untouched.

## Presets (user-confirmed)

| Preset | Base URL | Token var |
|---|---|---|
| Anthropic (default) | — (clears provider keys) | — |
| z.ai (GLM) | `https://api.z.ai/api/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| mimo | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| OpenRouter | `https://openrouter.ai/api` | `ANTHROPIC_AUTH_TOKEN` |
| Custom | blank, user-typed | `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` (selectable) |

Plus dynamic entries: `copy from <profile>` for every other profile whose
`settingsEnv` (manifest, falling back to live) contains `ANTHROPIC_BASE_URL`.
Copy-from clones the source profile's provider keys EXCEPT the token value —
the token field is left for the user to fill (their own secret).

## Form fields ↔ env vars

Known keys handled by labeled fields (env var name shown as fine print under each):

- Base URL → `ANTHROPIC_BASE_URL`
- Auth token → `ANTHROPIC_AUTH_TOKEN` (Custom preset may switch the var to
  `ANTHROPIC_API_KEY` via a small select). Secret mode by default (picker over
  stored secret names, saved as `secret://<name>`), with the existing plain-value
  toggle.
- Model overrides (3 optional text inputs: opus / sonnet / haiku) →
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Blank = key omitted.
- Request timeout ms (optional) → `API_TIMEOUT_MS`. Blank = omitted.

**Advanced** (collapsed `<details>`): the existing raw `EnvRowsEditor` holding every
`settingsEnv` key NOT covered by the form. Round-trip guarantee: on open, the map is
split into form-known keys and advanced leftovers; on save, form output and advanced
rows are merged back into one `settingsEnv` map. No key is ever dropped or
duplicated.

## Behavior

- **Preset detection on open**: base URL matches a preset → that preset selected;
  any other non-empty URL → Custom; no URL → Anthropic (default).
- **Selecting a preset**: fills Base URL, sets the token var, clears the three model
  fields and timeout (they're provider-specific). Advanced keys untouched.
- **Selecting Anthropic (default)**: clears all form-known keys (base URL, token,
  models, timeout) from the resulting map. Advanced keys untouched.
- **Copy from profile**: fills base URL, token VAR NAME, models, timeout from the
  source profile's provider keys; token VALUE left empty for the user.
- **Save**: merged map goes into the PATCH body's `settingsEnv` exactly as today;
  the existing save-guard (secret mode with no secret picked blocks save) applies to
  the token field and advanced rows.
- Seeding from `liveSettingsEnv` when the manifest map is empty (existing behavior)
  is preserved — the split/merge operates on whichever map seeds the editor.

## Structure & testing

- New module `packages/ui/src/lib/provider.ts`: preset table (`PROVIDER_PRESETS`),
  known-key list, and pure functions
  `splitProviderEnv(env)` → `{ form: ProviderForm, advanced: Record<string,string> }`
  and `mergeProviderEnv(form, advanced)` → `Record<string,string>`, plus
  `detectPreset(baseUrl)`. `ProviderForm` = `{ baseUrl, tokenVar, tokenValue,
  models: { opus, sonnet, haiku }, timeoutMs }` (all strings, empty = unset;
  tokenValue keeps the raw map value, i.e. may be `secret://…`).
- `ProfileEditor.tsx` renders the form from that module; the provider section's
  raw editor moves inside the Advanced `<details>`.
- Tests: the ui package has no test runner — add a vitest file under
  `packages/cli/test/` that imports the pure module directly from
  `../../ui/src/lib/provider.ts` (vitest transpiles TS) and covers: split/merge
  round-trip with unknown keys, preset detection (exact match / custom / none),
  Anthropic-default clearing, token var switch, blank-field omission.
- Build check + sandboxed e2e spot-check (z.ai shape renders as z.ai preset with
  populated fields; save round-trips byte-equal when nothing changed).

## Out of scope

- Backend/manifest/API changes of any kind.
- User-editable preset storage (Custom + copy-from covers it).
- Provider-specific model name suggestions/validation.
