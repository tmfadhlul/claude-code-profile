# ccprofiles UI Dashboard — Design Spec

**Date:** 2026-07-05
**Status:** Approved

## Problem

Everything in ccprofiles is CLI-only. Managing profiles, MCP drift, secrets, and sync across a growing setup is faster and clearer in a visual panel — especially the MCP drift matrix and profile editing. Users want a single `clp ui` command that opens a dashboard to do everything the CLI does.

## Goal

A local web dashboard, launched with `clp ui`, that manages the full surface: profiles (list/create/edit), tokens/secrets (list/add/reveal/delete/migrate), MCP servers (matrix + add/remove/sync), manifest status/apply, doctor, and LAN sync (devices/pull). Self-contained for npm (no external CDN), localhost-only, secure enough to reveal secret values.

## Decisions (from brainstorm)

- **Command:** `clp ui` (LAN sync stays `clp serve`). No breaking change.
- **Stack:** React + Vite + shadcn/ui frontend in a new `packages/ui`; built static assets shipped inside the CLI package and served by a localhost HTTP server.
- **Secrets:** UI can add/update/delete secrets, list names, and **reveal values on click** (localhost + token gated).
- **API:** thin layer over `core` — the same functions the CLI commands already call, so UI and CLI never drift.

## Architecture

```
packages/
├── core/                       # unchanged
├── cli/
│   └── src/ui/
│       ├── command.ts          # registers `clp ui`
│       ├── server.ts           # localhost http.Server: JSON API + static UI
│       └── api.ts              # request handlers → core + secretsStore
└── ui/                         # React + Vite + shadcn/ui
    ├── src/…
    └── dist/                   # vite build output
```

Build copies `packages/ui/dist` → `packages/cli/dist/ui/`, included in the CLI package `files` and served locally.

### Data flow

```
browser ──fetch /api/* (X-CCP-Token)──▶ cli/ui/server ──▶ cli/ui/api ──▶ core (discover/plan/apply/secrets/sync)
        ◀──────── JSON ───────────────
browser ◀── GET / (static SPA from cli/dist/ui) ──
```

## Security model

The UI server is stricter than the LAN sync server because it can reveal secrets.

- **Bind 127.0.0.1 only.** Never `0.0.0.0`. Not reachable off the machine.
- **Session token.** A `randomBytes(32).base64url` token is generated at launch. The browser is opened to `http://127.0.0.1:<port>/?t=<token>`. The SPA reads `t` from the URL and sends it as `X-CCP-Token` on every `/api` call.
- **Token check** on every `/api` request via `timingSafeEqual`; missing/wrong → 401.
- **Origin check.** Reject `/api` requests whose `Origin` header is present and not `http://127.0.0.1:<port>` / `http://localhost:<port>` — blocks a malicious website in the same browser from driving the API (CSRF). Same-origin SPA fetches send a matching Origin.
- **No token in logs.** The full URL is printed once to the terminal for the user; not written to any file.
- Reveal endpoint returns plaintext only over this authenticated localhost channel; the value is shown transiently in the UI and never persisted client-side.

## API surface

All under `/api`, all require `X-CCP-Token`. JSON in/out. Mutations run the existing plan→apply path with backups.

| Method | Path | Core call |
|---|---|---|
| POST | `/api/adopt` | `buildManifest` from live + `ensureRootGitignore` + save (bootstrap when no manifest exists) |
| GET | `/api/profiles` | `discoverProfiles` + `loadManifest` merge → rows (name, dir, auth, account, mcp count, launcher, adopted?) |
| POST | `/api/profiles` | body `{name, from?}` → append profile to manifest (same as `create`) → save + apply |
| PATCH | `/api/profiles/:name` | body `{env?, links?, launcher?}` → update manifest profile → save + apply |
| GET | `/api/mcp` | manifest → `{servers: name[], profiles: [{name, has: name[]}]}` (drift matrix) |
| POST | `/api/mcp` | body `{name, command, args?, targets: name[]|"all"}` → add def + attach → save + apply |
| DELETE | `/api/mcp/:name` | body `{targets}` → remove from targets, drop def if unreferenced → save + apply |
| POST | `/api/mcp/sync` | body `{from, to: name[]|"all"}` → copy mcp list → save + apply |
| GET | `/api/secrets` | `store.list()` → names + backend |
| GET | `/api/secrets/:name` | `store.get(name)` → `{value}` (reveal; 404 if absent) |
| PUT | `/api/secrets/:name` | body `{value}` → `store.set` |
| DELETE | `/api/secrets/:name` | `store.delete` |
| POST | `/api/secrets/migrate` | rc scan + rewrite (same as CLI) → `{migrated: name[]}` |
| GET | `/api/status` | `planApply` dry-run → pending action descriptions or `[]` |
| POST | `/api/apply` | `planApply`+`executeApply` → `{performed, backupDir}` |
| GET | `/api/doctor` | same checks as CLI doctor → `{problems: string[]}` |
| GET | `/api/devices` | `loadDevices` → list |
| POST | `/api/sync` | body `{from, withSecrets?, dryRun?}` → pull + apply |
| POST | `/api/bundle/export` | → returns bundle bytes as download |
| POST | `/api/bundle/import` | multipart/base64 body → import + apply (server-side confirmation implied by the action) |

`api.ts` reuses: `discoverProfiles`, `buildManifest`, `loadManifest`/`requireManifest`, `saveManifest`, `planApply`, `executeApply`, `collectAssets`, `writeAssets`, `exportBundle`/`importBundle`, `loadDevices`, `fetchRemote`/`fetchSecrets`, and the CLI's `secretsStore(ctx)`.

## UI

React + Vite + shadcn/ui. Sidebar layout, light/dark (shadcn theme).

- **Status (home):** drift summary; "Apply" button (disabled when in sync); shows backups dir after apply.
- **Profiles:** table (name, dir, auth, account, MCP count, launcher). "Create" dialog (name + copy-from select). Row → edit drawer (env key/value rows with secret:// picker, links, launcher).
- **MCP:** the drift matrix as an interactive grid — rows = servers, cols = profiles, cells are checkboxes. Toolbar: "Add server" dialog (name/command/args/targets), "Sync from → to". Changes queue then "Apply".
- **Secrets:** list (name + backend). "Add secret" dialog. Each row: reveal/hide toggle (calls reveal endpoint), delete. "Migrate from rc files" button.
- **Sync:** paired devices list; per device "Pull" (+ with-secrets checkbox, dry-run preview). Note: pairing itself stays CLI (`clp pair`) in v1.
- **Doctor:** findings as cards with the suggested fix; "Re-run" button.

Small shared `api.ts` client in the UI wraps fetch with the token from `?t=`.

## Build & ship

- `packages/ui/package.json`: Vite + React + shadcn deps (devDeps for build; nothing added to core/cli runtime deps).
- Root scripts: `build:ui` (vite build) → copy `packages/ui/dist` into `packages/cli/dist/ui/`. `build` runs core+cli tsc then `build:ui` then the copy. A small `scripts/copy-ui.mjs` does the copy (portable across OSes).
- `packages/cli/package.json` `files` adds `dist/ui`. Runtime deps unchanged (server uses `node:http` + `node:fs`; no framework at runtime).
- CI gains the UI build in the existing `npm run build` step (no new job).
- Version bump: `claude-account-sync` → 0.2.0 (new feature), `ccprofiles-core` unchanged (no core changes expected; if any, bump patch).

## Error handling

- API: try/catch per handler; 4xx for bad input with a `{error}` message the UI surfaces as a toast; 500 generic (no internal detail), full detail to the server's stderr only.
- Missing manifest → 409 `{error: "no manifest yet", hint: "run adopt"}`; UI shows an "Adopt your profiles" empty-state with a button that POSTs `/api/adopt`.
- Static server: unknown non-`/api` path → serve `index.html` (SPA routing).
- Port in use → try a random port; print the chosen one.

## Testing

- **API unit tests (vitest):** each handler against sandbox homes (`CCPROFILES_TEST_HOME` + `CCPROFILES_PASSPHRASE`), same harness as CLI tests. Cover: token required (401 without), Origin rejection, profiles CRUD, mcp add/sync, secret set/reveal/delete, status/apply, doctor.
- **Playwright smoke (Playwright MCP available):** launch `clp ui --no-open` on a fixed port against a sandbox home, drive the real dashboard — adopt, create a profile, toggle an MCP + apply, reveal a secret, run doctor — asserting live DOM. One end-to-end guard.

## Out of scope (v1)

Pairing from the UI (stays `clp pair`), live drift auto-refresh/websockets (manual refresh), multi-user/remote access (localhost only), editing raw manifest YAML in-browser, theming beyond shadcn light/dark.

## Adopt-from-empty

Add `POST /api/adopt` (build manifest from live + ensureRootGitignore + save) so a fresh user can bootstrap entirely from the UI.
