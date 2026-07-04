# ccprofiles — Design Spec

**Date:** 2026-07-05
**Status:** Approved (sections 1–2 explicitly; remainder delegated by user)

## Problem

Power users run multiple Claude Code accounts (API, personal sub, office, alt providers) via separate `CLAUDE_CONFIG_DIR` directories (`.claude`, `.claude-oauth`, `.claude-staffinc`, `.claude-z`, …) switched by hand-written shell functions. This setup has no management layer:

- MCP server lists drift between profiles (each `.claude.json` is edited independently).
- Skills/commands are shared via hand-made symlinks; other assets (settings, `CLAUDE.md`, `.mcp.json`) are duplicated and drift.
- API keys and OAuth tokens sit in plaintext in `.zshrc`.
- Creating a profile for a new account means manually cloning a dir, editing rc files.
- Replicating the setup on a second machine (including cross-OS, e.g. macOS → native Windows) is entirely manual.

## Goal

An open-source, cross-platform (macOS, Linux, native Windows, WSL) CLI that manages multi-profile Claude Code setups: list/create/adopt profiles, manage and sync MCP servers, store secrets outside rc files, and replicate the whole setup across machines over the **local network** (device-to-device, no cloud dependency).

## Decisions (from brainstorm)

- **Form:** Node.js CLI (`ccprofiles`, alias `ccp`). Node is guaranteed present (Claude Code requires it). Core logic in a library package so a web dashboard can layer on it later (v2).
- **Sync transport:** LAN peer-to-peer over HTTPS. No GitHub/cloud requirement. Mac is the user's master in practice, but the tool is symmetric.
- **Remote scope v1:** sync only. Management commands always operate locally; `sync` pulls/pushes manifest between paired devices. No persistent daemon.
- **v1 feature set (all four):** profiles list/create/adopt, MCP manage + sync, export/import bundle, token/secret management.

## Architecture

Three layers of state:

1. **Live state** — the actual `.claude*` dirs + shell rc files. Claude Code owns these; ccprofiles reads them and writes surgically.
2. **Manifest** — a local repo at `~/.ccprofiles/` declaring desired state. Platform-neutral (templated paths, secret refs). Versioned with a local git commit per change (history/rollback without cloud). Optional git remote for off-site backup.
3. **Secrets store** — per-machine, never in the manifest. OS-native keychain with encrypted-file fallback.

### Package layout

```
ccprofiles/
├── packages/core/     # discovery, manifest, diff, apply, secrets, platform adapters, sync
└── packages/cli/      # thin commander-based CLI over core
```

pnpm workspace (or npm workspaces), TypeScript, ESM. Published to npm as `ccprofiles` (bin: `ccprofiles`, `ccp`).

### Data flow

```
adopt/export:  live dirs ──read──▶ manifest (~/.ccprofiles, local git)
sync:          deviceA manifest ──LAN HTTPS (paired)──▶ deviceB manifest ──apply──▶ live dirs
secrets:       OS keychain ──inject at apply──▶ rc launcher functions / env
```

## Manifest format

`~/.ccprofiles/` layout:

```
manifest.yaml        # the declaration (below)
assets/
  hub/skills/…       # real file copies of shared skills
  hub/commands/…
  profiles/<name>/   # per-profile CLAUDE.md, settings.json overlays
devices.yaml         # paired peers (name, host, cert fingerprint) — tokens NOT here
.git/                # local history
```

`manifest.yaml`:

```yaml
version: 1
hub: default            # profile whose skills/commands are the shared source
profiles:
  - name: oauth
    dir: "{home}/.claude-oauth"
    launcher: cl-auth          # generated shell function name
    auth: oauth                # oauth | api-key | env
    env: {}                    # extra env vars; values may be secret://<name>
    links:                     # symlink/junction plan
      skills: hub
      commands: hub
    mcp: [mcp-obsidian, playwright, …]   # names referencing defs below
  - name: z
    auth: env
    env: { ANTHROPIC_BASE_URL: "…", ANTHROPIC_AUTH_TOKEN: "secret://z-token" }
    …
mcpServers:
  playwright: { command: npx, args: ["-y", "@playwright/mcp@latest"], env: {} }
  mcp-obsidian: { command: uvx, args: […], env: { OBSIDIAN_API_KEY: "secret://obsidian-key" } }
settings:               # per-profile settings.json keys ccprofiles owns (managed subset)
  oauth: { … }
```

Rules:

- Paths templated: `{home}`, `{profile}`. Rendered per-OS by platform adapters.
- Secrets referenced as `secret://<name>`, resolved from the local secrets store at apply time. A manifest is always safe to share/commit.
- Sessions, history, projects, caches are **never** exported.

## Platform adapters

| Concern | macOS/Linux/WSL | Native Windows |
|---|---|---|
| rc integration | managed block in `~/.zshrc`/`~/.bashrc` | managed block in PowerShell `$PROFILE` |
| links | `ln -s` | NTFS junction (`mklink /J` equivalent via Node `fs.symlink('junction')`, no admin) |
| paths | `/Users/x/...`, `/home/x/...` | `C:\Users\x\...` |
| keychain | `security` (macOS), `secret-tool` (Linux) | Windows Credential Manager via PowerShell/DPAPI |

rc files use a marked block the tool fully owns:

```
# >>> ccprofiles managed >>>
cl-auth() { … CLAUDE_CONFIG_DIR="$HOME/.claude-oauth" claude "$@"; }
…
# <<< ccprofiles managed <<<
```

Launcher functions fetch secrets at launch (e.g. `ANTHROPIC_API_KEY="$(ccp secrets get anthropic-api-key)"`) so no key ever sits in the rc file.

## Secrets store

- Backends tried in order: macOS Keychain (`security` CLI) → Linux `secret-tool` → Windows Credential Manager (PowerShell `CredentialManager`/DPAPI) → fallback AES-256-GCM encrypted file `~/.ccprofiles/secrets.enc` with a user passphrase.
- `ccp secrets migrate` scans rc files for known key patterns (`ANTHROPIC_API_KEY=`, `CLAUDE_CODE_OAUTH_TOKEN=`, `sk-ant-…`), moves values into the store, and rewrites the rc to use `secret://` indirection. Backs up the rc first.
- `secrets list` shows names + backend only, never values. `secrets get <name>` prints the raw value to stdout (this is the injection mechanism used by launcher functions); it is the only command that outputs a secret.

## LAN sync

- `ccp serve` starts an ephemeral HTTP server; confidentiality/integrity come from payload encryption, not TLS. *(Implementation note: replaced the original self-signed-TLS design — Node cannot mint X.509 certs without openssl, which isn't guaranteed on native Windows. Equivalent security with zero dependencies:)*
- `ccp pair <ip> --pin <pin>`: X25519 ECDH key exchange, authenticated both ways by HMAC over the handshake keyed with the 6-digit PIN shown on the serving device — a LAN MITM without the PIN cannot complete pairing, and the client also verifies the server. Both sides store `{name, token, pairingKey}`; all subsequent payloads are AES-256-GCM sealed with the pairing key.
- `ccp sync --from <device> [--with-secrets] [--dry-run]`: pulls the peer's manifest + assets, shows a diff summary, applies locally (with backups). `--with-secrets` additionally transfers secret values over the pinned TLS channel directly into the local keychain — never written to disk.
- `ccp devices`: lists paired devices; mDNS auto-discovery is a stretch goal — v1 ships manual IP + paired-device cache (last known IP retried first).
- Serve is on-demand (foreground, Ctrl-C to stop). No daemon in v1.

## Apply mechanics (safety)

- **Surgical writes:** ccprofiles edits only the keys it owns — `mcpServers` in `.claude.json`, its managed rc block, its symlinks, files under `assets/` it placed. It never rewrites whole files it doesn't own, and never touches `history.jsonl`, `projects/`, `sessions/`, caches, or OAuth session state.
- **Atomic:** write temp file + rename.
- **Backups:** every mutating command copies touched files to `~/.ccprofiles/backups/<timestamp>/` first. `ccp rollback` restores the latest backup set (stretch: pick by timestamp).
- **Dry-run:** every mutating command supports `--dry-run` printing the exact planned changes.
- **Locked file tolerance:** if Claude Code is running and a config write races, detect changed mtime and re-read before write; warn user to close sessions for `apply`.

## CLI surface (v1)

```
Profiles:  ccp list · ccp create <name> · ccp adopt · ccp doctor
MCP:       ccp mcp list [--profile X] · ccp mcp add/rm <name> [--profile X|--all] ·
           ccp mcp sync --from <p> --to <p1,p2|--all>
Secrets:   ccp secrets set/get/list/rm · ccp secrets migrate
Sync:      ccp serve · ccp pair <ip> · ccp devices · ccp sync --from <dev> [--with-secrets] · ccp diff
Bundle:    ccp export <file.ccb> · ccp import <file.ccb>     # offline fallback (tar.gz, no secrets)
Manifest:  ccp status (live vs manifest drift) · ccp apply (manifest → live) · ccp snapshot (live → manifest)
```

`ccp adopt` is the day-one command: scans `$HOME` for `.claude*` dirs and rc files for `CLAUDE_CONFIG_DIR` functions, builds the initial manifest interactively (confirm each discovered profile), and offers `secrets migrate`.

## Error handling

- Any parse failure of a live config → abort that profile's operation with a clear message; never write a file that failed to re-serialize.
- Sync failures are transactional: manifest is pulled to a temp dir, validated, then swapped; apply only runs on a valid manifest.
- Pairing failures (wrong PIN, fingerprint mismatch) abort with explicit security warning on mismatch.
- Missing secret at apply time → warn and leave a `secret://` placeholder comment in the rc launcher; command exits non-zero listing missing names.

## Testing

- **Unit (vitest):** manifest parse/validate/render, diff engine, rc block writer, path templating per platform adapter (adapters injectable with fake fs/home).
- **Integration:** fixture home dirs (copies of a realistic multi-profile layout) in temp dirs; run adopt → mutate → apply → assert file state. Runs on macOS/Linux/Windows in CI (GitHub Actions matrix).
- **Sync:** two in-process server/client instances over localhost, full pair + sync + with-secrets flow against a mock keychain backend.

## Out of scope (v1)

Web dashboard (v2, layers on core), mDNS discovery, background daemon, remote command execution on peers, plugin marketplace management beyond listing, Claude Desktop config.

## Open-source packaging

MIT license, npm package `ccprofiles`, README with the multi-account story, GitHub Actions CI (test matrix + release). Repo name suggestion: `ccprofiles`.
