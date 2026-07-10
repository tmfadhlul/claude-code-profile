# Plugin sharing across profiles — design

Date: 2026-07-10
Status: Approved (design), pending implementation plan

## Problem

Claude Code plugins are per-profile and don't propagate. Install a plugin
(e.g. `ponytail`) while on the `oauth` profile and it's invisible on every
other profile — even after syncing skills/commands. A plugin's state is two
things, and clp currently manages neither:

1. **Files** — `<configDir>/plugins/` holds `cache/` (plugin code),
   `marketplaces/` (source repos), `data/` (plugin runtime data), and the
   registries `installed_plugins.json` / `known_marketplaces.json`. Each
   profile has its own real `plugins/` dir.
2. **Enable toggle** — `enabledPlugins` in `settings.json`, a map
   `"<name>@<marketplace>": true`. Per profile.

clp's `links` only symlink `skills`/`commands` to the hub, and its settings
sync only covers `settings.json`'s `env` block — so neither the plugin files
nor the enable toggle travel.

## Goal

Opt a set of profiles into shared plugins: install a plugin from any shared
profile and it is available and enabled on all of them.

## Decisions (from brainstorming)

- **Files:** live symlink to a shared pool (reuse the session-sharing pool
  model), not on-demand copy and not hub-linking.
- **Migration:** **seed-or-adopt**, NOT union-merge (see below).
- **Enable toggle:** on apply, union `enabledPlugins` across all shared-plugins
  profiles and write the union into each of their `settings.json`.

## Why seed-or-adopt, not union-merge

Session-sharing union-merges (combine everyone's history). Plugins can't:
`installed_plugins.json` / `known_marketplaces.json` are registries. A
file-level union (pool-wins-on-clash) would keep one profile's registry while
copying another profile's cache files in as orphans not listed in that
registry — an incoherent pool. Instead:

- **First** shared profile **seeds** the pool: backup → move its `plugins/`
  into `<manifestRoot>/shared/plugins` → symlink.
- **Later** shared profiles **adopt**: backup their `plugins/` → replace with a
  symlink to the pool (their prior set stays in the backup, not merged).

Guidance: share your plugin-rich profile first; others adopt its set. New
installs from any shared profile land in the pool and appear everywhere.

## Architecture

### 1. Data model

- `ProfileSchema` gains `sharedPlugins: z.boolean().default(false)` (parallels
  `sharedSessions`).
- Pool: `<manifestRoot>/shared/plugins`.

### 2. Discovery

`discoverProfiles` (claude profiles only) reads `enabledPlugins` from
`settings.json` into a new `LiveProfile.enabledPlugins: Record<string, boolean>`
(alongside the existing `settingsEnv` read). Codex profiles have no plugins;
`enabledPlugins` stays `{}` for them.

Discovery already records symlinked children in `LiveProfile.links`, so
`links['plugins']` reports whether `plugins/` is pooled — used for idempotency.

### 3. Apply — plugin dir link (seed-or-adopt)

`planApply`, per claude profile with `sharedPlugins: true` whose `plugins/`
isn't already symlinked to the pool → emit a `share-plugins-dir` action
`{ from: <dir>/plugins, to: <pool>/plugins }`. When `sharedPlugins: false` but
currently linked → `unshare-plugins-dir` (snapshot pool back to a real dir).

`executeApply`:
- `share-plugins-dir`: ensure pool parent exists. If `<pool>/plugins` does NOT
  exist yet (**seed**): backup `from`, move `from` → `<pool>/plugins`, then
  symlink `from` → `<pool>/plugins`. If the pool already exists (**adopt**):
  backup `from`, remove `from`, symlink `from` → `<pool>/plugins`. If `from`
  doesn't exist: just create the pool dir (if missing) and symlink.
- `unshare-plugins-dir`: remove the symlink, recreate a real dir, copy the
  pool's contents into it. Never deletes the pool.

Rationale for a dedicated action (vs reusing `share-session-dir`): sessions
union-merge; plugins seed-or-adopt. Different semantics → its own action, so
neither regresses.

### 4. Apply — `enabledPlugins` union

`planApply` computes `union` = the merge of `enabledPlugins` across every
`sharedPlugins: true` profile (from discovery). For each such profile whose
live `enabledPlugins` differs from `union`, emit `set-enabled-plugins`
`{ settingsPath: <dir>/settings.json, enabledPlugins: union }`.

`executeApply` `set-enabled-plugins`: read the profile's `settings.json`
(preserve other keys — same surgical-JSON pattern as `set-settings-env`), set
`cfg.enabledPlugins = <union>`, atomic-write.

Union is additive: a plugin enabled on any shared profile becomes enabled on
all shared profiles. (A profile disabling a plugin is re-enabled on next
apply while the plugin remains enabled elsewhere — acceptable for v1.)

### 5. CLI

- `clp plugins share <profile>` / `clp plugins unshare <profile>` — flip
  `sharedPlugins`, save manifest, apply.
- The flag is also settable via the existing profile-edit path.

### 6. UI

- `sharedPlugins` on the profile row (GET) and PATCH (`/api/profiles/:name`),
  a checkbox in the profile editor next to `sharedSessions`.

## Files / units

- `packages/core/src/manifest.ts` — `sharedPlugins` field.
- `packages/core/src/discovery.ts` — read `enabledPlugins`; `LiveProfile`
  gains `enabledPlugins`.
- `packages/core/src/apply.ts` — `share-plugins-dir` / `unshare-plugins-dir` /
  `set-enabled-plugins` actions; planApply logic; `describe()`.
- `packages/core/src/adopt.ts` + all `ProfileDecl` literals — `sharedPlugins: false`.
- `packages/cli/src/commands/plugins.ts` (new) — `plugins share/unshare`.
- `packages/cli/src/context.ts` — register.
- `packages/cli/src/ui/api.ts` — `sharedPlugins` on GET/PATCH profiles.
- `packages/ui/src/components/ProfileEditor.tsx` — checkbox + `ProfileRow` field.

## Testing (vitest, sandboxed home)

- **core:** `sharedPlugins` schema default; planApply emits `share-plugins-dir`
  (seed when pool absent) and `set-enabled-plugins` (union) on opt-in, no-op
  when already linked + converged, `unshare-plugins-dir` on toggle-off;
  executeApply seed moves the dir into the pool and symlinks; adopt (pool
  exists) backs up + symlinks without merging; `set-enabled-plugins` unions and
  preserves other settings keys; unshare restores a real dir, pool intact;
  discovery reads `enabledPlugins`.
- **fixture consistency:** extend the stale-field guard test to include
  `sharedPlugins` (as done for `sharedSessions`/`skipPermissions`).
- **cli/api:** `PATCH /api/profiles/:name` sets `sharedPlugins`; GET returns it;
  `clp plugins share` e2e — a seeded profile's `plugins/` becomes a symlink to
  the pool and the enable union is written.

## Edge cases

- Seed order matters: first shared profile wins the pool contents; document
  "share your plugin-rich profile first".
- `unshare` never deletes pool data.
- `data/` (plugin runtime state) is shared as part of the dir — acceptable
  ("shared install" implies shared plugin state); consistent with claude-mem
  already being global.
- Codex profiles have no `plugins/`; `sharedPlugins` is a no-op for them
  (planApply only acts on claude profiles for this flag).
- Windows: symlink uses `'junction'` (same as other link actions).
- `apply --dry-run` lists the new actions (`describe()`).

## Out of scope (v1)

- Per-profile selective enable of shared plugins (union-only).
- Merging different profiles' pre-existing plugin sets (seed-or-adopt only).
- Sharing plugins for Codex (no plugin system there).
