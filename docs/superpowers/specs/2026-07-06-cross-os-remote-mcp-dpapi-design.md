# Cross-OS fixes: remote MCP servers + Windows DPAPI secrets backend

**Date:** 2026-07-06
**Status:** Approved

## Problem

Two independent bugs surfaced running `clp ui` on native Windows:

1. **Manifest unloadable with a remote MCP server.** `McpServerSchema` requires
   `command`, but Claude Code supports remote (HTTP/SSE) MCP servers that carry a
   `url` and no `command` (e.g. the hosted ClickUp server). `adopt` copies the live
   server verbatim and `saveManifest` does not validate, so a `{ type, url }` entry
   lands in `manifest.yaml`; every later `loadManifest`/`parseManifest` then throws
   `mcpServers.<name>.command: Required`, 500-ing every manifest-backed endpoint.

2. **No Windows secrets backend.** `defaultBackend` returns Keychain on macOS,
   libsecret on Linux, and otherwise the encrypted-file backend, which needs
   `CCPROFILES_PASSPHRASE`. On Windows with no passphrase set, every secrets endpoint
   throws `encrypted-file backend requires a passphrase` — surfaced as a raw 500.

## Design principle

Keep the existing "shell out to the OS's own credential tooling, zero native
modules" pattern (macOS `security`, Linux `secret-tool`). Windows uses **DPAPI** via
built-in PowerShell — no dependency, no passphrase, per-user encryption.

## Fix 1 — remote-aware MCP schema (`packages/core/src/manifest.ts`)

- `McpServerSchema`: `command` becomes `z.string().optional()`; add a `.refine`
  requiring `command !== undefined || url !== undefined` with message
  `mcp server must have either "command" (local) or "url" (remote)`.
- `saveManifest`: round-trip guard — after `serializeManifest`, call `parseManifest`
  on the result and throw if it fails, so a manifest that cannot be reloaded is never
  written. (`parseManifest` already runs the schema + cross-ref + `assertSafeManifest`
  checks; this makes "if it saved, it loads" an invariant and stops silent poisoning.)
- No change needed in apply/discovery/adopt: they copy `McpServerDef` verbatim into
  `.claude.json`, and a `{ type, url }` object round-trips fine to Claude Code.
- `McpServerDef` type gains optional `command` — audit call sites for `.command`
  access; none currently dereference it unconditionally (apply writes the whole
  object; rendering never touches mcp).
- **UI add-server** (`POST /api/mcp`) is unchanged: defining a *new* server via the
  form still requires `command` (local servers only). Adopting/keeping a remote
  server works; adding a remote one from the UI is out of scope (documented).

Retroactive effect: the user's existing poisoned `manifest.yaml` parses successfully
once `command` is optional — no manual repair needed.

## Fix 2 — Windows DPAPI backend (`packages/core/src/secrets.ts`)

New `DpapiBackend implements SecretsBackend` (`name = 'windows-dpapi'`):

- DPAPI is an encrypt/decrypt primitive with no store of its own, so the backend
  **encrypts each value with DPAPI and stores the ciphertext in a file** at the same
  `secretsFilePath` the encrypted-file backend uses — same storage shape as
  `FileBackend` (`{ entries: Record<string, string> }`, value = base64 DPAPI blob),
  but the per-value key is the user's DPAPI key instead of a passphrase.
- Crypto is delegated to an injectable pair for testability:
  `constructor(private filePath: string, private crypt: DpapiCrypt = powershellDpapi)`
  where `type DpapiCrypt = { protect(plain: string): Promise<string>; unprotect(b64: string): Promise<string> }`.
- `powershellDpapi` shells out to `powershell -NoProfile -NonInteractive -Command -`,
  passing the plaintext/ciphertext via a **spawn env var** (never argv, so secrets
  never hit the process command line), using
  `[System.Security.Cryptography.ProtectedData]::Protect/Unprotect(bytes, $null, 'CurrentUser')`
  with base64 in/out. Runs `LoadWithPartialName('System.Security')` / `Add-Type` as
  needed for the assembly.
- `get`/`set`/`delete` operate on the file map via `atomicWrite`, mirroring
  `FileBackend`; `get` returns `null` for a missing key.
- `defaultBackend` for `win32`: probe PowerShell + DPAPI once (a trivial
  `protect('')` round-trip, or `powershell $PSVersionTable`); on success return
  `DpapiBackend`, else fall through to the existing encrypted-file+passphrase path
  (headless/no-PowerShell). macOS/Linux paths unchanged.
- `CCPROFILES_PASSPHRASE` still forces `FileBackend` directly (CLI `secretsStore`
  short-circuits on it), so existing Windows users who set a passphrase are
  unaffected; DPAPI is only the *no-passphrase* default.

## Fix 3 — UI surfaces the secrets-backend setup state (`packages/cli/src/ui/api.ts`, `SecretsPage.tsx`)

- `GET /api/secrets` currently opens the store eagerly and 500s when it can't. Wrap
  its failure: if opening the backend throws, respond `200` with
  `{ names: [], backend: 'unavailable', error: <message> }` instead of 500.
- `SecretsPage` renders an inline setup card when `backend === 'unavailable'`
  ("Secrets backend not configured — on Windows this uses DPAPI automatically; set
  `CCPROFILES_PASSPHRASE` to use the encrypted-file backend") rather than a silent
  failed toast. Other secrets actions keep their existing error toasts.

## Testing

- core `manifest.test.ts`: remote server (`{ type:'http', url }`, no command) parses;
  server with neither command nor url is rejected; `saveManifest` round-trip guard
  throws on an unloadable manifest (and a valid remote-server manifest saves+reloads).
- core `secrets.test.ts`: `DpapiBackend` set/get/delete round-trip and missing-key
  `null` using a **fake `DpapiCrypt`** (e.g. base64 identity) + temp file — no real
  PowerShell, so the suite runs on the macOS/Linux dev box and CI. `defaultBackend`
  selection is covered by injecting platform; the win32 PowerShell probe is guarded
  so a non-Windows run doesn't attempt it.
- cli `ui-api-secrets.test.ts`: `GET /api/secrets` returns `backend:'unavailable'`
  (not 500) when the store cannot open (simulate by forcing the file backend with no
  passphrase on a non-darwin/linux platform context, or by injecting a throwing
  store) — assert 200 + empty names.
- Full build + suite; sandboxed e2e spot-check that a manifest containing a remote
  MCP server loads and `clp ui` serves `/api/profiles`.

## Out of scope

- Adding remote MCP servers from the UI form (only *keeping* adopted ones).
- Windows Credential Manager (this uses DPAPI + file, which needs no module).
- Migrating existing encrypted-file secrets into DPAPI.
