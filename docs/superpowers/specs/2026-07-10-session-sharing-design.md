# Session sharing across profiles — design

Date: 2026-07-10
Status: Approved (design), pending implementation plan

## Problem

Each ccprofiles profile is a separate `CLAUDE_CONFIG_DIR` (`~/.claude`,
`~/.claude-oauth`, `~/.claude-<name>`). Claude Code writes session data
per config dir, so switching profiles mid-project loses the other
profile's session history: start project A under profile A, switch to
profile B for the same project, and `--resume` / the `/resume` picker
can't see profile A's sessions.

Two distinct stores are involved, and only one is actually isolated:

- **claude-mem observations** live in `~/.claude-mem/` (a single
  home-level SQLite + chroma store, ~289M). Already global across
  profiles — every profile with the claude-mem *plugin* enabled reads and
  writes the same DB. Nothing to build here; the only gap is profiles
  where the plugin isn't enabled (e.g. `.claude-mimo`). Out of scope for
  this feature beyond noting it.
- **Session transcripts** live in `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-uuid>.jsonl`
  (plus `todos/` and `shell-snapshots/`). Genuinely per-profile. This is
  what this feature shares.

Note: claude-mem is a Claude Code *plugin* (capture via hooks, storage in
`~/.claude-mem/`, and a bundled `mcp-search` MCP for querying). It is not
a user-defined `mcpServers` entry, which is why it does not appear in the
clp MCP drift view. Managing plugins in clp is a separate potential
feature, not part of this one.

## Goal

Let selected profiles share one pool of session transcripts (and
`todos/` + `shell-snapshots/`) so a project's history is visible and
resumable regardless of which opted-in profile is active. Manage it
entirely through clp (CLI + UI), including a read-only viewer of projects
and sessions.

## Decisions (from brainstorming)

- **Sharing scope:** per-profile opt-in into ONE shared pool. A boolean
  flag per profile; profiles with it on share, profiles with it off stay
  isolated. (Not named groups; not forced-global.)
- **Data scope:** `projects/` + `todos/` + `shell-snapshots/`.
- **Migration:** on opt-in, union-merge the profile's existing dirs into
  the pool, taking a backup first, then replace the dirs with symlinks.
- **UI viewer:** read-only browser in v1 (no delete/export).
- **Mechanism:** apply-managed symlinks to a pool (chosen over
  sync-on-switch and per-file links).

## Approach (A — apply-managed symlink to a pool)

Add a per-profile `sharedSessions` flag (parallels the existing
`skipPermissions` flag). `apply` symlinks `projects/`, `todos/`,
`shell-snapshots/` under each opted-in profile to a shared pool. First
opt-in for a profile runs a one-time migrate step (backup → union-merge →
replace with symlink); later applies are idempotent no-ops once the
symlink exists. Live sharing, fits the existing manifest → planApply →
executeApply model.

Rejected alternatives:
- **Sync-on-switch** (copy transcripts when switching profiles): no live
  sharing, needs a profile-switch hook clp doesn't own, races if two
  profiles touch one project.
- **Per-session file links** (symlink individual `.jsonl`): bookkeeping
  cost with no benefit over linking the whole dir.

## Data model & pool layout

`ProfileSchema` (packages/core/src/manifest.ts) gains:

```
sharedSessions: z.boolean().default(false)
```

Extend `assertSafeManifest` coverage / fixture-consistency as needed (a
boolean has no injection surface, but the stale-field guard test must
know about it — see Testing).

Pool location: `<manifestRoot>/shared/` with three fixed subdirs:

```
<manifestRoot>/shared/
  projects/          # <encoded-cwd>/<session-uuid>.jsonl
  todos/
  shell-snapshots/
```

Created lazily on first opt-in. Deliberately NOT named `.claude-*`, so
`discoverProfiles` (matches `.claude` / `.claude-*`) never mistakes the
pool for a profile.

## Apply flow

**Discovery** (`LiveProfile`, packages/core/src/discovery.ts): report, per
profile, whether each of `projects/`, `todos/`, `shell-snapshots/` is
already a symlink pointing into the pool. This makes planning idempotent.

**planApply** (packages/core/src/apply.ts), per profile:
- `sharedSessions: true` + a dir not yet linked → emit
  `migrate-shared-dir { profileDir, entry, poolDir }`.
- `sharedSessions: true` + already linked → skip (no-op).
- `sharedSessions: false` + currently linked (toggled off) → emit
  `unshare-dir` (replace symlink with a real dir seeded from the pool, so
  the profile keeps a snapshot).

Both are new members of the `ApplyAction` union. The existing `link`
action and its "refuse to replace a non-symlink" guard are untouched —
migration gets its own action precisely so it doesn't defeat that guard.

**executeApply**:
- `migrate-shared-dir`: ensure pool subdir exists → if the profile's dir
  is a real dir, back it up (existing `backupFiles` / `backupRoot` path),
  then union-merge its files into the pool (copy a file only if that path
  isn't already present in the pool; session UUIDs are unique so real
  collisions don't happen; on a rare path clash the pool copy wins and the
  source copy remains in the backup) → remove the real dir →
  `symlink(profileDir/entry -> poolDir/entry)`. If the profile's dir does
  not exist yet, just create the symlink.
- `unshare-dir`: remove the symlink → recreate a real dir → copy the
  pool's current contents into it. Never deletes pool data.

`describe()` gains cases for both new actions so `apply --dry-run` lists
them.

Windows: symlinks already use `'junction'` in the existing `link`
executor; migration reuses the same dir-symlink call.

## CLI & UI surface

**CLI:**
- `clp sessions share <profile>` / `clp sessions unshare <profile>` — flip
  `sharedSessions`, save manifest, run apply.
- `clp sessions list` — print projects → sessions (terminal form of the
  read-only view).
- The flag is also settable via the existing profile-edit path alongside
  `skipPermissions`.

**UI backend:** one new route `GET /api/sessions` that walks the pool and
each isolated profile's `projects/`, returning:

```
[{ scope: 'shared' | <profileName>,
   project: '<decoded cwd>',
   sessions: [{ id, mtime, messageCount, firstPrompt, gitBranch, model, sizeBytes }] }]
```

Metadata parsed cheaply per `.jsonl` (first user message + line count +
first record's cwd / branch / model); reads are streamed/capped so a
pool at ~289M scale does not blow memory. The `sharedSessions` toggle
rides the existing `PATCH /api/profiles/:name` route.

**UI frontend:** new **Sessions** page — top-level list of projects
(shared pool first, then each isolated profile as its own group); expand a
project to see sessions with timestamp, message count, first-prompt
snippet, branch, model. Read-only. The ProfileEditor gets a
`sharedSessions` checkbox next to the skip-permissions one.

## Known limitations

- **No per-session profile attribution in the pool.** Claude Code
  transcripts don't record which `CLAUDE_CONFIG_DIR` / profile wrote them,
  so pooled sessions show project / time / first-prompt / branch / model
  but no owner. Attribution is only shown for isolated (non-shared)
  profiles, grouped under their name.

## Edge cases

- Concurrent runs (two profiles, same project) → distinct session UUIDs,
  no file clash.
- Pool already has a file at a migrating path → pool wins; source copy
  remains in the backup; logged.
- Toggling off never deletes pool data (snapshots a copy back).
- `apply --dry-run` lists the new actions like any other.

## Testing

Vitest, sandboxed home per the `verify` skill (never touches real
`~/.claude*` or the keychain).

- **core:** schema default (`sharedSessions` defaults false); planApply
  emits `migrate-shared-dir` on opt-in, no-op when already linked,
  `unshare-dir` on toggle-off; executeApply union-merge keeps both sides'
  sessions; backup created; second apply is idempotent.
- **cli/api:** `GET /api/sessions` shape; `PATCH /api/profiles/:name` sets
  `sharedSessions`; `clp sessions share` / `clp sessions list` e2e.
- **fixture consistency:** extend the existing stale-field guard test
  (the one covering `skipPermissions`) to include `sharedSessions`.

## Out of scope (v1)

- Named sharing groups.
- Sharing `history` inside `.claude.json` (lives in the JSON blob, would
  need a merge step, not a symlink).
- Session delete/export from the UI.
- Managing Claude Code plugins (incl. enabling claude-mem) from clp.
