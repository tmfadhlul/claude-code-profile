# Comprehensive UI: profile editing, deletion, rc management, secret attachment

**Date:** 2026-07-05
**Status:** Approved

## Goal

Make `clp ui` a full management surface, not just a viewer. Users should be able to:
create profiles (exists), **edit** every manifest-level aspect of a profile, **delete**
profiles, **preview and update the rc file's managed block**, and **manage which
profiles use which secrets** — all without dropping to the CLI.

## Scope decisions (user-confirmed)

- **Profile editor:** full — env vars (with secret picker), launcher, links, MCP toggles.
- **Delete:** manifest-only. `~/.claude-<name>` stays on disk; reversible via adopt.
- **rc management:** preview current vs. rendered managed block with diff highlight +
  one-click "Update .zshrc". No free-form rc editing (manifest stays source of truth).
- **Secrets↔profiles:** show usage per secret and support attach/detach from the
  Secrets page.

## API changes (`packages/cli/src/ui/api.ts`)

### Extended

- `GET /api/profiles` — each row additionally includes (from the manifest, when
  adopted): `env: Record<string,string>`, `links: Record<string,string>`,
  `mcpNames: string[]`. Unadopted profiles return `env: {}`, `links: {}`,
  `mcpNames: []` (existing `mcp` count field stays as-is for compatibility).
  Env values may contain `secret://<name>` references; these are refs, not secret
  values, and are already user-visible in the rc file today.

### New

- `DELETE /api/profiles/:name`
  - 404 if not in manifest.
  - Removes the profile declaration, saves the manifest, runs apply (this removes
    the launcher function from the rc managed block).
  - Never touches the profile directory.
  - Response: `{ ok: true }`.
- `GET /api/rc`
  - Response: `{ rcFile: string, current: string | null, rendered: string, inSync: boolean }`.
  - `current` = the text between `BEGIN_MARK`/`END_MARK` in the rc file (inclusive of
    marks), `null` when the file or block is absent.
  - `rendered` = `renderRcBlock(manifest, platform)`.
  - `inSync` = `current === rendered`.
  - Requires manifest (409 like other routes when missing).
- `POST /api/rc`
  - Backs up the rc file via `backupFiles([rcFile], backupRoot, stamp)` when it exists,
    then writes `upsertManagedBlock(existingContent, rendered)`.
  - Response: `{ ok: true, backupDir: string | null }`.

No new endpoint for secret usage: the UI derives usage by scanning profile `env`
values for the `secret://` prefix. Attach/detach reuse `PATCH /api/profiles/:name`
with an updated `env` object.

## UI changes (`packages/ui`)

### Profiles page

- Row actions: **Edit** (opens editor sheet), **Delete** (confirm dialog stating the
  directory stays on disk and the launcher will be removed from the rc file).
- Editor sheet (per profile), sections:
  1. **Launcher** — text input; empty = no launcher (null).
  2. **Env vars** — key/value rows with add/remove. Each value has a mode toggle:
     *plain* (text input) or *secret* (select from stored secret names, stored as
     `secret://<name>`).
  3. **Links** — key/value rows (value: `hub` or a path), add/remove.
  4. **MCP servers** — checkbox per known server (from `GET /api/mcp`).
  - Save: one `PATCH` for env/links/launcher, then MCP diffs via existing
    `POST /api/mcp` / `DELETE /api/mcp/:name` targeted at this profile. Refresh + toast.
- Editing disabled for unadopted profiles (tooltip: "Adopt first").

### New "Shell RC" tab

- Shows: rc file path, in-sync badge, side-by-side (or stacked) view of `current`
  vs `rendered` block with changed lines highlighted (simple line-based diff done
  client-side; no diff library).
- **Update .zshrc** button → `POST /api/rc`; disabled when in sync; toast shows
  backup location.

### Secrets page

- Each secret row shows badges for profiles referencing it (`profile · ENV_VAR`).
- **Attach** action per secret → dialog: profile select + env var name input
  (default `ANTHROPIC_API_KEY`) → PATCH that profile's env adding
  `VAR: secret://<name>`.
- Badge ✕ detaches (PATCH with the env entry removed), with a confirm toast.

### api client (`packages/ui/src/lib/api.ts`)

Add: `deleteProfile(name)`, `rc()`, `updateRc()`.

## Error handling & safety

- rc writes always back up the rc file first (same mechanism apply uses).
- Only the managed block is ever rewritten; content outside the marks is untouched
  (guaranteed by `upsertManagedBlock`).
- All new routes go through the existing token auth and `HttpError` handling.
- Delete + attach/detach + rc update all re-run or preserve existing apply semantics
  so manifest, disk, and rc never drift silently.

## Testing

- `packages/cli/test/ui-api-*.test.ts` additions:
  - `GET /api/profiles` includes `env`/`links`/`mcpNames` for adopted profiles.
  - `DELETE /api/profiles/:name`: removes from manifest, 404 unknown, rc block loses
    the launcher after apply, profile dir untouched.
  - `GET /api/rc`: correct extraction (present/absent block), `inSync` flag.
  - `POST /api/rc`: writes block, preserves content outside marks, creates backup.
- Keep the ui-api-sync test (UI api client ↔ server routes parity) passing with the
  new client methods.
- Final: sandboxed end-to-end pass via the project `verify` skill.

## Out of scope

- Free-form rc editing.
- Deleting profile directories from the UI.
- Profile-centric page restructure (single-page tabs stay).
