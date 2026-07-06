# Per-profile "skip permissions" launcher toggle

**Date:** 2026-07-06
**Status:** Approved

## Goal

A per-profile boolean that, when on, makes the profile's launcher run
`claude --dangerously-skip-permissions`, toggleable from `clp ui`. Applying the
change rewrites the shell rc block automatically (like every other profile edit).

## Decisions (user-confirmed)

- **Dedicated boolean** `skipPermissions` per profile (not a generic launcher-args field).
- **Launcher-only**: applies to profiles that have a launcher; the `default` profile
  (no `cl-*` launcher) has the toggle disabled.

## Manifest (`packages/core/src/manifest.ts`)

- `ProfileSchema` gains `skipPermissions: z.boolean().default(false)`.
- `assertSafeManifest`: nothing new (a boolean has no injection surface).
- Every `ProfileDecl` construction site (adopt, CLI `create`, UI `POST /api/profiles`)
  adds `skipPermissions: false`.

## Launcher rendering (`packages/core/src/rcblock.ts`)

- `renderPosix` / `renderPwsh`: when `pr.skipPermissions` is true, emit the claude
  invocation with the flag before user args:
  - posix: `CLAUDE_CONFIG_DIR="…" claude --dangerously-skip-permissions "$@"`
  - pwsh: `$env:CLAUDE_CONFIG_DIR = "…"; claude --dangerously-skip-permissions @args`
- `renderRcBlock` already filters to `pr.launcher` profiles, so the default profile is
  naturally excluded; no launcher → flag never rendered.

## Discovery / adopt

- No live source (it's a launcher behavior, not in `.claude.json`). `LiveProfile` is
  unchanged; `buildManifest` sets `skipPermissions: false` for every adopted profile.

## Apply

- No new `ApplyAction`. The managed rc block re-renders from the manifest, and the
  existing `planApply` rc drift check (`!rcCurrent.includes(block)`) plans the rc-block
  update. `clp apply` (and the UI's `applyAndReport` on save) writes it, with the usual
  backup. Reloading an already-open shell is still the user's step (documented).

## UI / API

- `GET /api/profiles` rows include `skipPermissions: boolean` (from manifest; `false`
  when absent/unadopted).
- `PATCH /api/profiles/:name` accepts `skipPermissions`; reject non-boolean with
  `400 'skipPermissions must be a boolean'`; runs before `assertSafe`/save/apply like
  the other fields.
- Profile editor: a checkbox **"Skip all permission prompts (`--dangerously-skip-permissions`)"**
  with a short red warning ("bypasses every confirmation — use only for trusted
  profiles"). **Disabled when the profile has no launcher** (launcher field empty),
  with the note "no launcher — plain claude". Save includes it in the PATCH body.
- Profiles table: a compact `skip-perms` badge on the launcher cell when the flag is on,
  so it's visible at a glance.

## CLI

No new subcommand (consistent with the provider form). Toggle in `clp ui`; `clp apply`
renders it. `clp create` defaults it to `false`.

## Security / sync note

`skipPermissions` travels with the manifest, so a synced peer/bundle enabling it will
render the flag on that machine's launcher too — consistent with how launcher/env
already travel (the manifest is the user's own trusted artifact). No new trust boundary.
The flag is dangerous by design; the UI warns, and it only ever affects the explicit
`cl-*` launcher, never plain `claude`.

## Testing

- core `rcblock.test.ts`: posix and pwsh launchers include
  `--dangerously-skip-permissions` (before `"$@"`/`@args`) when `skipPermissions` is
  true, and omit it when false; flag placement is exact.
- core `manifest.test.ts`: `skipPermissions` parses and defaults to `false`.
- cli `ui-api-core.test.ts`: `GET /api/profiles` includes `skipPermissions`; `PATCH`
  sets it (rc block gains the flag after apply) and rejects a non-boolean with 400.
- UI: build check (no test runner). Sandboxed e2e: create a launcher profile, PATCH
  `skipPermissions:true` → rc file's managed block contains the flag for that launcher;
  PATCH `false` → removed.

## Out of scope

- Applying the flag to the `default` profile / plain `claude`.
- A generic launcher-args field.
- Detecting an existing flag from the rc file during adopt.
