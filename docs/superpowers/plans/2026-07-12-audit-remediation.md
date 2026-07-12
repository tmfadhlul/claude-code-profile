# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix every finding from the 2026-07-12 audit (Critical → Low) across security, core correctness/data-safety, dashboard/API, and packaging — plus the quick-win features (chmod, no-echo `secrets set`, `--version`, dark mode, confirms, token scrub, a11y). Each fix ships with a test.

**Architecture:** Small surgical fixes grouped by concern into independently-reviewable tasks. Core changes come with unit tests; UI changes verified by `npm run build` + the full suite staying green. No net-new subsystems here (background jobs / mDNS / UI-parity / restore are a separate designed effort).

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Commander, Node http/child_process, React/Vite/Tailwind, Vitest.

## Global Constraints

- Every task: TDD (failing test first) where a behavior is testable; commit with explicit paths (the tree has pre-existing untracked `AGENTS.md`/`CLAUDE.md`/`.claude/` and a modified `.gitignore` that must NEVER be staged — never `git add -A`/`git add -u` without resetting those).
- Secret-bearing files must be `0600`; dirs holding them `0700`.
- `assertSafeManifest` is the single injection barrier — values that reach a shell/`spawn`/rc file must be whitelist-validated and must not start with `-`.
- Preserve existing behavior/tests; do not regress the full suite (currently 230 tests).
- Run `npm run build` + `npx vitest run` green before each commit.

---

### Task 1: File-permission hardening (Critical)

Secret-bearing files are written world-readable. Lock them to `0600` and their dirs to `0700`.

**Files:** `packages/core/src/fsutil.ts`, `packages/core/src/devices.ts`, `packages/core/src/secrets.ts`, `packages/core/src/apply.ts`; Test: `packages/core/test/fsutil.test.ts` (+ a devices/secrets perm assertion).

- [ ] **Step 1 — failing test.** In `fsutil.test.ts`, assert that `atomicWrite(path, content, { mode: 0o600 })` produces a file whose `statSync(path).mode & 0o777 === 0o600`. Add a test that `secretsStore` / `saveDevices` writes are `0600`.
- [ ] **Step 2 — run, expect fail** (`atomicWrite` has no mode option yet).
- [ ] **Step 3 — implement.** Give `atomicWrite(filePath, content, opts?: { mode?: number })` a mode param; write the temp file with `writeFile(tmp, content, { encoding: 'utf8', mode: opts?.mode ?? 0o644 })` AND `chmod` after rename (rename preserves the temp's mode, but set explicitly to avoid umask surprises). Then, at every secret-bearing call site, pass `{ mode: 0o600 }`:
  - `devices.ts` `saveDevices` (contains the pairing key + token),
  - `secrets.ts` `FileBackend` (`secrets.enc`) and its index/`DpapiBackend` writes,
  - `apply.ts` `set-settings-env` write (resolved plaintext tokens land here).
  Also `mkdir(manifestRoot, { recursive: true, mode: 0o700 })` where the manifest root / backups / secrets dir are created (secrets.ts + wherever `manifestRoot` is first made). Windows: `chmod` is a no-op there — guard with `if (process.platform !== 'win32')` only if a test flakes; Node tolerates the mode arg cross-platform, so prefer leaving it unconditional.
- [ ] **Step 4 — run, expect pass** + `npm run build` + full suite.
- [ ] **Step 5 — commit** `fix(core): write secret-bearing files 0600 / dirs 0700`.

---

### Task 2: assertSafeManifest hardening — reject leading `-`, whitelist dir (High + Low)

Close the argv/flag-injection gap: a plugin id / marketplace source / profile name starting with `-` currently passes and can inject a flag into `claude` or the launcher.

**Files:** `packages/core/src/manifest.ts`, `packages/cli/src/commands/plugins.ts`; Test: `packages/core/test/manifest.test.ts`.

- [ ] **Step 1 — failing tests.** `parseManifest` must throw on: a profile `name`/`launcher` starting with `-`; a marketplace name/source starting with `-`; a plugin id whose name or marketplace half starts with `-` (e.g. `--flag@mkt`, `x@-mkt`); a profile `dir` containing a `..` segment. Add a positive test that normal values still pass.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** In `manifest.ts`: change `SAFE_NAME` to forbid a leading hyphen — `/^[A-Za-z0-9_][A-Za-z0-9_-]*$/` (still allows internal `-`, not leading). Apply the same "no leading `-`" rule to `SAFE_SOURCE` (`/^[A-Za-z0-9._@:/][A-Za-z0-9._/@:-]*$/`). For `p.dir`: keep the `SHELL_META` blacklist but ALSO whitelist-reject any path with a `..` segment (`renderPath`-independent: split on `/` and `\\`, reject `..`). Confirm the plugin-id split validation in `assertSafeManifest` uses the updated `SAFE_NAME` for both halves.
  In `plugins.ts` `claudeRunner`, as defense-in-depth insert a literal `'--'` before the untrusted positional in `install`/`uninstall`/`marketplaceAdd` args arrays (e.g. `['plugin','install','--',id]`) — verify `claude plugin install -- <id>` is accepted (the audit notes spawn already avoids shell; this stops flag parsing). If `claude` rejects `--`, instead assert-reject leading `-` at the runner boundary.
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): reject leading-dash identifiers; forbid .. in profile dir`.

---

### Task 3: Manifest plaintext-secret git gate (High)

Stop auto-committing a plaintext token into `~/.ccprofiles/.git`.

**Files:** `packages/core/src/manifest.ts` (`saveManifest`), `packages/cli/src/commands/*` doctor; Test: `packages/core/test/manifest.test.ts`.

- [ ] **Step 1 — failing test.** `saveManifest` into a temp git repo with a manifest whose serialized YAML contains `sk-ant-xxxx` must: still WRITE `manifest.yaml`, but NOT create a git commit (or create it only after the token is absent). Assert the file exists and `git log` has no new commit (or a thrown/warned result the caller surfaces). Also: a manifest with only `secret://` refs commits normally.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** In `saveManifest`, before the `git add/commit`, scan the serialized yaml for a plaintext token pattern (`/sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/`). If matched, skip the commit and return a signal (e.g. throw a typed `ManifestError('refusing to git-commit a manifest containing a plaintext secret — run: ccprofiles secrets migrate')` AFTER writing the file, or return `{ committed: false, reason }`). Choose the least-disruptive shape: write file always; on token match, do not commit and surface a warning via the return value that callers log. Add a `doctor` check that warns if `~/.ccprofiles/.git` has any remote configured.
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): refuse to git-commit a manifest with a plaintext secret; doctor warns on remote`.

---

### Task 4: Config-JSON read safety — ENOENT vs corrupt (High)

A corrupt/locked `.claude.json`/`settings.json` is treated as "new file" and its other keys are wiped.

**Files:** `packages/core/src/apply.ts` (`set-mcp-servers` claude branch, `set-settings-env`), `packages/core/src/codex.ts` (`writeCodexMcpServers`); Test: `packages/core/test/apply.test.ts`.

- [ ] **Step 1 — failing test.** Seed a profile `.claude.json` with invalid JSON (e.g. `{ "oauthAccount": …` truncated) plus a valid key, run the apply action that writes `mcpServers`, and assert it does NOT clobber the file to `{ mcpServers }` (either preserves via abort-with-error, or errors clearly). Repeat for `settings.json` / codex `config.toml`.
- [ ] **Step 2 — run, expect fail** (current code wipes it).
- [ ] **Step 3 — implement.** Replace `try { cfg = JSON.parse(readFile) } catch { /* new file */ }` with: attempt read; if it throws with `code === 'ENOENT'` treat as new (`cfg = {}`); otherwise (read succeeded but parse failed, or EACCES) `backupFiles([path], ...)` then `throw new Error(\`refusing to overwrite unreadable ${path} — back up + fix it, then re-apply\`)`. Same guard in `writeCodexMcpServers` (TOML parse). Thread the backup dir/stamp already available in `executeApply`.
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): never replace a config whose existing content is unreadable`.

---

### Task 5: writeAssets backs up before overwrite (High)

`sync`/`bundle import` clobber local skills/commands/CLAUDE.md with no backup.

**Files:** `packages/core/src/assets.ts` (`writeAssets`), `packages/cli/src/commands/bundle.ts` (confirm copy); Test: `packages/core/test/assets.test.ts`.

- [ ] **Step 1 — failing test.** With an existing hub `skills/demo/SKILL.md` on disk, call `writeAssets` with a different content for that path and a `backupRoot`; assert the OLD content is preserved under `backups/<stamp>/` and the new content is written.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** `writeAssets` takes a `backupRoot`/`stamp` (thread from `sync.ts`/`bundle.ts`/`api.ts` callers, which already have `ctx.backupRoot` + a stamp); before each `atomicWrite` of an existing target, `backupFiles([target], backupRoot, stamp)` (or `backupTree` for dirs). Update `bundle import`'s `--yes` warning text to mention that local skills/commands/guidance files will be overwritten (backed up first).
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): back up assets before writeAssets overwrites them; clearer import warning`.

---

### Task 6: adopt/snapshot no longer oscillates shared pools (High)

`buildManifest` records pool symlinks as plain `links` + hardcodes shared flags false → next apply dumps the whole pool back.

**Files:** `packages/core/src/adopt.ts` (`buildManifest`); Test: `packages/core/test/adopt.test.ts`.

- [ ] **Step 1 — failing test.** Build a `LiveProfile` whose `links` includes `projects` → a path under `<manifestRoot>/shared/projects` (a pooled symlink). Assert `buildManifest` yields a profile with `sharedSessions: true` and NO `projects`/`todos`/`shell-snapshots` entries in `links`; and that a subsequent `planApply` against that manifest + the same live state emits no `unshare-session-dir`. Same idea for a pooled `plugins` symlink → `sharedPlugins: true` (note: on `main`, plugins is the MCP-style model — plugins are NOT pooled, so ONLY the session dirs apply; verify against the current schema and only handle the session entries `projects`/`todos`/`shell-snapshots`/codex `sessions`).
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** In `buildManifest`, pass in (or derive) the shared pool root (`join(home, '.ccprofiles', 'shared')` via platform). When mapping `lp.links`, if an entry's target is under `<sharedRoot>/<entry>` for a session entry, DON'T add it to `links`; instead set `sharedSessions = true` for that profile. Keep non-pool links as-is.
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): adopt recognizes pooled session dirs as sharedSessions, not plain links`.

---

### Task 7: Correctness mediums — codex MCP drift, home-prefix boundary, legacy restore safety

**Files:** `packages/core/src/apply.ts`, `packages/core/src/platform.ts`, `packages/core/src/plugins.ts`; Tests: `apply.test.ts`, `platform` test, `plugins.test.ts`.

- [ ] **Step 1 — failing tests.** (a) A shared MCP server with `type:'http'` assigned to a codex profile: after one apply, a re-`planApply` emits NO `set-mcp-servers` for that profile (converges). (b) `toTemplate('/Users/tmfadhlul-old/.claude', home='/Users/tm')` does NOT produce `{home}fadhlul-old/...` — it returns the path untemplated (not under home). (c) `restoreLegacyPluginSymlink` where the symlink target is MISSING: it backs up / does not silently leave an empty dir — assert it throws or preserves rather than returning success with an empty `plugins/`.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** (a) In `planApply`, when building `desired` for a codex profile, strip the `type` field from each server (mirror `writeCodexMcpServers`) so `current` (no type) equals `desired`. (b) In `toTemplate`, require a path separator boundary: only template when `norm === home || norm.startsWith(home + sep)`. (c) In `restoreLegacyPluginSymlink`, if the readlink target does not exist, do NOT unlink-and-empty: either leave the symlink untouched and return false, or throw a clear error — never leave an empty real dir with no backup.
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): codex MCP drift converges; home-prefix boundary; safe legacy plugin restore`.

---

### Task 8: Correctness lows — git error distinction, isWithin platform

**Files:** `packages/core/src/manifest.ts` (`saveManifest`), `packages/core/src/apply.ts` (`isWithin`); Tests where feasible.

- [ ] **Step 1 — failing test.** For `isWithin`, add a test that passes a `Platform` with `os:'win32'` and asserts junction/separator handling uses `p.os`, not `process.platform`. (git-commit-error distinction is hard to unit-test; cover by code review + a targeted test that a non-repo dir still writes the file without throwing.)
- [ ] **Step 2 — run, expect fail (isWithin).**
- [ ] **Step 3 — implement.** `isWithin` reads the `Platform.os` threaded into `planApply`/`executeApply` rather than `process.platform`. In `saveManifest`, only swallow the git error when stderr/message indicates "nothing to commit" / "not a git repository"; rethrow (or warn via return) on other git failures so history isn't silently dropped.
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(core): thread Platform.os in isWithin; don't swallow real git failures`.

---

### Task 9: `secrets set` no-echo prompt + `--version` (High + feature)

**Files:** `packages/cli/src/commands/secrets.ts`, `packages/cli/src/context.ts`; Tests: `packages/cli/test/*`.

- [ ] **Step 1 — failing tests.** `secrets set <name>` with NO value argument prompts (inject a fake reader via ctx/opts) and stores the entered value without it appearing in argv. `secrets set <name> <value>` with an explicit value prints a warning to stderr about shell history (still works). `ccprofiles --version` prints the CLI package version.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** `secrets set <name> [value]`: when `value` is omitted, read from a masked prompt (Node `readline` with muted output, or a small helper; make the reader injectable — e.g. `ctx.promptSecret` defaulting to the real masked reader — so tests inject a fake). When `value` IS given, `process.stderr.write` a one-line warning that it lands in shell history. Add `program.version(<cli package.json version>)` in `buildProgram` (import the version; read it from the package.json via a small `../package.json` import assertion or a generated constant).
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `feat(cli): masked secrets-set prompt + argv warning; --version flag`.

---

### Task 10: Packaging — prepack rebuild, core README, exports, documented override

**Files:** `packages/cli/package.json`, `packages/core/package.json`, `packages/core/README.md` (new), root `package.json`.

- [ ] **Step 1 — implement + verify (no unit test; verify with `npm pack --dry-run`).**
  - Both `packages/{cli,core}/package.json`: set `"prepack": "cd ../.. && npm run build"` (cli keeps the README copy too — chain them: `"prepack": "cd ../.. && npm run build && node -e \"…copy README…\""`, or move the copy into the build). Ensure prepack does not loop.
  - Create `packages/core/README.md` (short: what `ccprofiles-core` is, that the CLI is `claude-account-sync`, a link to the repo).
  - Add an `"exports"` map to `packages/core/package.json` (`"." → { types, import }`).
  - Add a one-line comment/field explaining the root `overrides: { vite }` pin (a comment isn't valid JSON — instead add a note to the repo README's Development section or a `// ` via a `"comment"` key is non-standard; put the rationale in `docs/` or the root README).
- [ ] **Step 2 — verify.** `npm run build` clean; `cd packages/cli && npm pack --dry-run` shows dist + README + webui and nothing extra; `cd packages/core && npm pack --dry-run` shows dist + README.
- [ ] **Step 3 — commit** `chore: rebuild-on-prepack, ccprofiles-core README, exports map`.

---

### Task 11: API hardening — session-scan cache, body cap, 404 secret-delete, batch profile PATCH

**Files:** `packages/cli/src/ui/api.ts`, `packages/cli/src/ui/http.ts`, `packages/core/src/sessions.ts`; Test: `packages/cli/test/ui-api-*.test.ts`.

- [ ] **Step 1 — failing tests.** (a) `GET /api/sessions` twice returns the same data and the second call does not re-read files whose mtime is unchanged (assert via a spy/counter or an exposed cache-hit signal). (b) `readJson` rejects a body over a cap (e.g. 5 MB) with a 413. (c) `DELETE /api/secrets/:name` for a name that doesn't exist returns 404 (not silent success). (d) A batched profile PATCH that changes env + mcp set applies ONCE (assert a single apply, e.g. one backup dir), not N times.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** (a) Add an mtime-keyed cache in `scanSessions` (or a thin cache layer in the route): remember `{ mtimeMs, size } → parsed` per file; skip re-parsing unchanged files; cap total bytes read per request (skip/annotate oversized transcripts). (b) In `readJson`/`readBody`, enforce a max content length (reject with `HttpError(413,'request too large')`). (c) `DELETE /api/secrets/:name`: check existence first, `HttpError(404)` if absent. (d) `PATCH /api/profiles/:name` accepts a `mcp: string[]` (full desired set) and applies once instead of the ProfileEditor issuing per-server add/rm calls; keep back-compat with the existing per-field patch. (Frontend switch to it happens in Task 12.)
- [ ] **Step 4 — run + build + suite.**
- [ ] **Step 5 — commit** `fix(api): cache session scan, cap body size, 404 unknown secret, batch profile apply`.

---

### Task 12: UI correctness + UX — toggle race, confirms, token scrub, parallel fetch, routing, batch save

**Files:** `packages/ui/src/pages/{McpPage,PluginsPage,ProfilesPage,SecretsPage,SyncPage}.tsx`, `packages/ui/src/components/ProfileEditor.tsx`, `packages/ui/src/App.tsx`, `packages/ui/src/lib/api.ts`. Verify: `npm run build` + suite.

- [ ] **Step 1 — implement (UI: verify by build + manual reasoning; no unit-test harness).**
  - **Toggle race:** in `McpPage`/`PluginsPage`, track in-flight cells as `Set<string>` (add key before await, delete in `finally`); disable a cell only while ITS key is in the set.
  - **Confirms:** wrap "Sync to all" (Mcp + Plugins), the skip-permissions toggle save, and secret detach in a confirm dialog (reuse the existing delete-confirm pattern).
  - **Token scrub:** in `lib/api.ts` bootstrap, after reading `t`, call `history.replaceState(null,'',location.pathname + location.hash)` to strip it from the address bar. (Keep it working: read once into a module constant first.)
  - **Batch save:** `ProfileEditor.save()` posts the full desired profile (env, mcp set, flags) via the Task-11 batched PATCH in one call instead of a patch + a loop of add/rm.
  - **Parallel fetch:** `ProfilesPage.load()` / `SecretsPage.load()` use `Promise.all` (match `StatusPage`).
  - **Routing:** back the active tab with `location.hash` (read on mount, write on change) so refresh/deep-link/back work.
  - **Sync preview:** `SyncPage` pull first calls the route with `dryRun:true`, shows the pending actions, then a confirm to apply for real.
  - **Progress:** show a spinner/"installing…" state on plugin/mcp reconcile toggles (the cell already disables; add a visible pending affordance).
- [ ] **Step 2 — verify.** `npm run build` type-checks clean; `npx vitest run` green (API tests exercise the batched PATCH).
- [ ] **Step 3 — commit** `fix(ui): toggle race, destructive confirms, token scrub, batch save, routing, sync preview`.

---

### Task 13: UI dark mode + accessibility

**Files:** `packages/ui/src/index.css`, a theme toggle in `App.tsx`, `packages/ui/src/pages/RcPage.tsx`, the matrix tables. Verify: `npm run build`.

- [ ] **Step 1 — implement.**
  - **Dark mode:** define the color tokens for dark under `@media (prefers-color-scheme: dark)` AND `:root[data-theme="dark"]` / `[data-theme="light"]`; add a persisted toggle (localStorage) in the sidebar that stamps `data-theme` on `<html>`. Verify every shadcn primitive reads the tokens (they should already).
  - **A11y:** RcPage diff lines get a non-color glyph (`+`/`−` prefix) in addition to the tint; matrix `<table>`s get `<caption class="sr-only">` and `scope="col"`/`scope="row"` on headers.
- [ ] **Step 2 — verify.** `npm run build` clean; suite green; spot-check both themes render (reasoning + the token structure).
- [ ] **Step 3 — commit** `feat(ui): dark mode + diff/table accessibility`.

---

## Verification (end of plan)

- [ ] `npm run build` clean; `npx vitest run` green (≥230 + new tests).
- [ ] `npm pack --dry-run` in both packages shows correct contents.
- [ ] Sandbox smoke per `.claude/skills/verify/SKILL.md`: a secret file is `0600`; a manifest with a plaintext token isn't committed; a corrupt `.claude.json` isn't clobbered; `ccprofiles --version` works; `clp ui` renders dark mode.

## Deferred to a separate designed effort (NOT in this plan)

Background-job/SSE model for plugin installs; mDNS device discovery; UI parity for bundle/snapshot/handoff; restore/undo command; plugin lifecycle (`update`/pin); `doctor --fix` auto-remediation; session-pool management UI. These are net-new subsystems needing their own brainstorm → spec → plan.
