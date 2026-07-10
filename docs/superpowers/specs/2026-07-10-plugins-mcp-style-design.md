# Plugins v2 — MCP-style per-profile management — design

Date: 2026-07-10
Status: Approved (design), pending implementation plan

## Problem

The shipped plugin-sharing feature (`sharedPlugins` flag → symlink `plugins/`
to a shared pool + union `enabledPlugins`) is wrong for plugins that must run
as a single instance. `claude-mem` enabled everywhere (union) runs on every
profile; and a shared `plugins/` symlink shares its state. The user wants
per-plugin, per-profile control — exactly the MCP model — where `claude-mem`
lives on one profile only.

## Research findings (Claude Code plugin internals)

- **No auto-install:** a plugin listed in `enabledPlugins` with its marketplace
  in `known_marketplaces.json` but no cached files is reported "not installed"
  and does not load. Writing JSON is not enough.
- **Official non-interactive CLI exists** (Claude ≥ 2.1.195, confirmed on
  2.1.206): `claude plugin install|uninstall|enable|disable|list <name>[@mkt]`
  and `claude plugin marketplace add|remove|list <source>`, all scoped to the
  active `CLAUDE_CONFIG_DIR`.
- **Copying plugin files between profiles is undocumented/fragile** — the
  registries embed absolute paths (`installPath`, `installLocation`). Avoid.

Conclusion: clp should NOT touch plugin files. It drives the official
`claude plugin` CLI per profile — the plugin analog of writing `mcpServers`.

## Goal

A plugin × profile matrix. Declare, per profile, which plugins it has; clp
reconciles each profile by running `claude plugin` with that profile's
`CLAUDE_CONFIG_DIR`. Manageable via CLI and the dashboard, mirroring MCP.

## Decisions (from brainstorming)

- **Fully per-profile**, no shared files/symlink. Mirrors MCP.
- **Reconcile by driving the official `claude plugin` CLI**, not file surgery.
- Replaces (reverts) the shipped `sharedPlugins`/symlink/union feature.

## Data model

`ProfileSchema`:
- **Remove** `sharedPlugins: boolean`.
- **Add** `plugins: z.array(z.string()).default([])` — this profile's plugin
  ids (`"<name>@<marketplace>"`), the analog of `mcp: string[]`.

`ManifestSchema`:
- **Add** `marketplaces: z.record(MarketplaceSchema).default({})` where
  `MarketplaceSchema = z.object({ source: z.string().min(1) })` — a registry of
  marketplace name → source (e.g. `"DietrichGebert/ponytail"` or a github repo
  spec), the analog of `mcpServers`. A plugin id `x@mkt` requires `mkt` present
  here so clp knows the source to `marketplace add` on a profile that lacks it.
- Validation: every profile plugin id `x@mkt` must have `mkt` in `marketplaces`
  (mirrors the existing "profile references undefined mcp server" check).
- `marketplaces` names and `source` are injection-safe-checked in
  `assertSafeManifest` (they are interpolated into a shelled-out command):
  marketplace name matches `SAFE_NAME`; source matches a conservative
  `^[A-Za-z0-9._/@:-]+$` (github `owner/repo`, URLs). Plugin ids: `name@mkt`
  where both parts match `SAFE_NAME`.

## Discovery

`discoverProfiles` (claude only) additionally reads:
- `known_marketplaces.json` → `LiveProfile.marketplaces: Record<string, { source: string }>`
  (source derived from the `.source.repo` / `.source.source` fields).
- Keeps the existing `enabledPlugins: Record<string, boolean>` as the live
  "installed & enabled" signal (used as current state for the matrix + reconcile
  diff). (`installed_plugins.json` keys could refine "installed vs enabled"
  later; v1 treats `enabledPlugins` true as "present".)

## Reconciler (pure planner + injectable runner)

New `packages/core/src/plugins.ts`:

- `planPluginReconcile(desired: string[], current: string[]): { install: string[]; uninstall: string[] }`
  — pure set diff. `install = desired \ current`, `uninstall = current \ desired`.
- `PluginRunner` interface: `{ install(id): Promise<void>; uninstall(id): Promise<void>; marketplaceAdd(source): Promise<void>; marketplaceList(): Promise<string[]> }`.
- `reconcileProfilePlugins(opts: { configDir, desired, current, marketplaces, runner }): Promise<string[]>`
  — for each `install` id, ensure its marketplace is added (via
  `runner.marketplaceList()` / `marketplaceAdd(source)`), then `runner.install(id)`;
  for each `uninstall`, `runner.uninstall(id)`. Returns a log of actions.
  Pure orchestration; all side effects go through `runner` (injectable → tests
  use a fake runner and assert the issued commands; no real `claude` in tests).

The CLI supplies a real `PluginRunner` that shells out:
`spawn('claude', ['plugin', 'install', id], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } })`
etc. `claude` missing on PATH → a clear error ("install Claude Code / ensure
`claude` is on PATH"). Reconcile is NOT part of the file-based
`planApply`/`executeApply` (kept pure + fast); it is driven by the `plugins`
commands and the UI, like `mcp` mutations trigger their own apply.

## CLI

Mirror `mcp`:
- `clp plugins list` — plugin × profile matrix (declared manifest state; a
  `live` marker where live `enabledPlugins` diverges).
- `clp plugins add <id> --profile <p> | --all [--marketplace <source>]` — if
  `id`'s marketplace isn't in the registry, `--marketplace <source>` defines it
  (else error, like `mcp add` needs `--command`); add `id` to the target
  profiles' `plugins`, save manifest, reconcile those profiles.
- `clp plugins rm <id> --profile <p> | --all` — remove from targets, reconcile.
- `clp plugins sync --from <p> --to <p1,p2> | --all` — copy one profile's plugin
  set to others, reconcile.
- `clp adopt` — builds `marketplaces` + per-profile `plugins` from discovery so
  existing installs come under management with zero manual config.

## UI

- `GET /api/plugins` → `{ marketplaces: string[]; profiles: { name; has: string[] }[] }`
  (mirrors `GET /api/mcp`).
- `POST /api/plugins` (add: `{ id, source?, targets }`), `DELETE /api/plugins/:id`
  (`{ targets }`), `POST /api/plugins/sync` (`{ from, to }`) — mirror the mcp routes.
- A **Plugins** page in the dashboard: a matrix toggle grid, an "Add plugin"
  dialog (id + marketplace source), and "sync from → all" — a near-copy of
  `McpPage.tsx`.

## Revert of the shipped symlink feature

- Remove `sharedPlugins` from `ProfileSchema` and every literal.
- Remove `share-plugins-dir` / `unshare-plugins-dir` / `set-enabled-plugins`
  from `apply.ts` (ApplyAction union, planApply block, executeApply handlers,
  describe, backup list) and their `apply.test.ts` cases.
- Remove `packages/cli/src/commands/plugins.ts`'s `share/unshare` (replaced by
  the new `plugins list/add/rm/sync` — same file, new verbs).
- Remove the `sharedPlugins` toggle from `ProfileEditor.tsx` and
  `ui/api.ts` GET/PATCH/POST.
- **Migration for anyone who already shared:** before reconciling a profile,
  if its `plugins/` is a symlink (the shipped feature pointed it at
  `<manifestRoot>/shared/plugins`), restore it to a real dir first: read the
  symlink target, `unlink` the symlink, `mkdir` a real `plugins/`, and copy the
  pool's contents into it — then `claude plugin` manages the real dir. The pool
  under `<manifestRoot>/shared/plugins` is left in place (harmless; can be
  deleted manually). This restore is a small helper invoked at the top of the
  per-profile reconcile, so it happens automatically the first time plugins are
  managed after upgrade.

## Testing

- **core:** `planPluginReconcile` set-diff; `reconcileProfilePlugins` with a fake
  `PluginRunner` asserts: marketplace added only when missing, install called for
  each new id, uninstall for each removed id, correct ordering; manifest schema
  `plugins` default + `marketplaces` + the "plugin references undefined
  marketplace" validation + `assertSafeManifest` rejects unsafe marketplace
  source / plugin id.
- **cli:** `plugins add/rm/sync/list` drive the reconciler (inject a fake runner
  via the context or a seam) and update the manifest; `adopt` builds
  `marketplaces` + `plugins` from a seeded `known_marketplaces.json` +
  `enabledPlugins`.
- **api:** `GET /api/plugins` shape; add/rm/sync routes mutate the manifest and
  invoke reconcile (fake runner).
- No test invokes the real `claude` binary.

## Edge cases / limitations

- `claude` not on PATH → clear error; reconcile aborts before mutating.
- Network/`claude plugin install` failure → surfaced per-plugin; manifest is
  still saved (declared intent), so a later `plugins sync`/reconcile retries.
- v1 treats `enabledPlugins:true` as "installed"; a plugin installed-but-disabled
  is re-installed (idempotent — `claude plugin install` on an installed plugin is
  a no-op/enable).
- `plugins` reconcile is not folded into the generic `clp apply` (keeps apply
  pure + offline); it runs from the `plugins` commands / UI.

## Out of scope (v1)

- Per-plugin version pinning.
- Managing project/local plugin scopes (user scope only).
- Codex (no plugins).
- Folding plugin reconcile into `clp apply`.
