# ccprofiles Sync + Bundle + Packaging (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Device-to-device LAN sync (pair with PIN, pull manifest+assets, optional secrets transfer), offline bundle export/import, and open-source packaging (README, LICENSE, CI).

**Architecture:** Zero-dependency crypto channel: X25519 ECDH key agreement authenticated by a 6-digit PIN (HMAC confirmation over the handshake transcript — a LAN MITM without the PIN cannot complete pairing). All payloads AES-256-GCM encrypted with the pairing key. Plain `node:http` transport (confidentiality/integrity come from the payload encryption, not TLS) — replaces the spec's self-signed-TLS design to avoid an openssl dependency; spec updated accordingly.

**Tech Stack:** node:crypto (x25519, hkdf, aes-256-gcm, hmac), node:http, node:zlib (bundle gzip), global fetch (Node ≥ 20).

## Global Constraints

(Same as Plan 1, plus:)
- `~/.ccprofiles/.gitignore` must exclude `secrets.enc`, `secret-names.json`, `devices.json`, `backups/` so `saveManifest`'s auto-commit never captures them.
- Secrets transfer only when server runs with `--allow-secrets`, values go straight into the client's secrets store, never to disk in plaintext.
- Assets = hub profile's `skills/**` + `commands/**` + each profile's `CLAUDE.md` (utf8 text map). No sessions/history/caches.

## Tasks

1. **core/crypto.ts** — `handshakeKeys()`, `deriveSharedKey(privateKey, peerPublicRaw, salt)` (X25519 + HKDF-SHA256 → 32B), `sealJson(key, obj)` / `openJson(key, sealed)` (AES-256-GCM, random 12B iv, base64 wire format `{iv, tag, data}`), `pinMac(key, role, pin)` (HMAC-SHA256). Tests: seal/open round-trip, tampered tag rejected, both sides derive equal keys, wrong-PIN mac mismatch.
2. **core/assets.ts** — `collectAssets(m, p): Promise<Record<string,string>>` (relative templated paths like `hub/skills/foo/SKILL.md`, `profiles/<name>/CLAUDE.md`) and `writeAssets(map, m, p)` (atomicWrite each under rendered paths). Tests with fixture home.
3. **core/devices.ts** — `DeviceEntry { name, host, port, token, key }`; `loadDevices(root)` / `saveDevices(root, list)` (devices.json via atomicWrite); `ensureRootGitignore(root)` writing the exclusion list. Test: round-trip + gitignore contents.
4. **core/syncserver.ts** — `startSyncServer(deps: { manifestRoot, home, platform, allowSecrets?, secretValues?: (names) => Promise<Record<string,string>>, port? }): Promise<{ port, pin, close() }>`. Endpoints (JSON POST): `/pair` (exchange pubkeys+salt), `/pair/confirm` (verify client pinMac, reply server pinMac + `{token}`; persist server-side device entry), `/manifest` (token-auth'd, sealed `{manifestYaml, assets}`), `/secrets` (403 unless allowSecrets; sealed name→value map).
5. **core/syncclient.ts** — `pairWithServer(host, port, pin, name)` → DeviceEntry (throws on mac mismatch), `fetchRemote(device)` → `{ manifestYaml, assets }`, `fetchSecrets(device, names)`.
6. **core test sync.e2e** — in-process server (port 0) + client: pair with correct PIN succeeds, wrong PIN rejected, sync pulls manifest+assets matching source, secrets endpoint gated by allowSecrets.
7. **core/bundle.ts** — `exportBundle(manifestYaml, assets): Buffer` (gzip JSON `{v:1, manifestYaml, assets}`), `importBundle(buf)`. Test round-trip.
8. **cli/commands/sync.ts** — `ccp serve [--port] [--allow-secrets]` (prints PIN + port, Ctrl-C to stop), `ccp pair <host> [--port] --pin <pin> [--name <n>]`, `ccp devices`, `ccp sync --from <device> [--with-secrets] [--dry-run]` (backup manifest, write pulled manifest+assets, run plan/apply respecting --dry-run, then secrets into local store if requested).
9. **cli/commands/bundle.ts** — `ccp export <file>` / `ccp import <file> [--dry-run]` (import = write manifest+assets then apply).
10. **adopt hardening** — `ccp adopt` also calls `ensureRootGitignore`. Test: gitignore exists after adopt.
11. **Packaging** — README.md (story, quickstart, command reference, security model), LICENSE (MIT), `.github/workflows/ci.yml` (node 20/22 × ubuntu/macos/windows matrix: `npm ci && npm run build && npm test`). Update spec's LAN-sync section to the ECDH-PIN design.
