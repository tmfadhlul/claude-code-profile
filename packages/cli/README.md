# ccprofiles

**Profile manager for [Claude Code](https://claude.com/claude-code) multi-account setups.**

Run Claude Code with several accounts — personal subscription, work OAuth, API key, alternative providers — each in its own `CLAUDE_CONFIG_DIR`? Then you know the pain: MCP server lists drift apart, skills get shared via hand-made symlinks, API keys end up in plaintext in your `.zshrc`, and setting up a second machine means an afternoon of copy-paste.

The `clp` command (also available as `ccprofiles`) fixes that:

- 🔎 **Adopt** your existing `.claude*` directories into a declarative manifest — zero manual config
- 🎛️ **Set up profiles the easy way** — a guided web form to create, edit, and delete profiles: launcher, env, links, MCP, and provider — no hand-editing config files
- 🌐 **Custom LLM providers per profile** — point a profile at z.ai (GLM), mimo, OpenRouter, or any Anthropic-compatible endpoint with a preset picker; base URL + token + model mappings managed for you, token kept in the keychain
- 🧩 **Manage MCP servers** across profiles: drift matrix, add/remove everywhere at once, sync one profile's set to others
- 🔐 **Secrets out of your rc files** — macOS Keychain / libsecret / encrypted file, with `clp secrets migrate` to clean up existing plaintext keys
- 🖥️ **Replicate to another machine over LAN** — PIN pairing, end-to-end encrypted, no cloud, works macOS ↔ Windows ↔ Linux ↔ WSL
- 🖼️ **Web dashboard** — `clp ui` opens a local browser panel to manage everything visually
- 📦 **Offline bundles** for the no-network case (`clp export setup.ccb`)
- 🛟 **Safe by design**: surgical config edits only, automatic backups, `--dry-run` everywhere, never touches your sessions/history

## Install

Requires **Node ≥ 20** (you have it — Claude Code needs it too).

```bash
npm install -g claude-account-sync
```

This installs two equivalent commands: `clp` (short) and `ccprofiles` (full). The docs below use `clp`.

<details><summary>Install from source instead</summary>

```bash
git clone https://github.com/tmfadhlul/claude-code-profile.git && cd claude-code-profile
npm install && npm run build
cd packages/cli && npm link
```

> Using nvm? `npm link` installs into the *active* node version — re-link after `nvm use <other>`.
</details>

## Quickstart

```bash
clp adopt --yes          # REQUIRED FIRST: scan ~/.claude* and build the manifest
clp list                 # see all your profiles
clp doctor               # find broken links & plaintext keys
clp secrets migrate      # move API keys from .zshrc into the OS keychain
```

Everything except `list`, `adopt`, and `doctor` needs the manifest, so `clp adopt --yes` is always step one — commands will remind you if you skip it.

Prefer a UI? `clp ui` opens the whole thing in your browser (see below).

### Manage MCP servers

```bash
clp mcp list                                   # server × profile drift matrix
clp mcp add shadcn --all --command npx --args "shadcn@latest,mcp"
clp mcp sync --from oauth --to office,z        # make profiles match
```

> **Scope:** `clp` manages **user-scope** MCP servers only (the top-level `mcpServers` in `~/.claude.json`). Local/project-scoped servers — added with `claude mcp add` at its default scope, stored under `projects[...]` or in a project `.mcp.json` — are intentionally left untouched (they're tied to a working directory). If a server isn't showing up in `clp mcp list`, re-add it at user scope: `claude mcp add <name> --scope user -- <command>`, then `clp adopt --yes`.

### New profile for a new account

```bash
clp create work --from oauth     # dir + launcher fn + copied MCP set
# restart shell, then:
cl-work                          # launches claude with CLAUDE_CONFIG_DIR=~/.claude-work
```

`clp apply` writes a launcher function per profile into your shell startup file — `.zshrc`/`.bashrc` on macOS/Linux, your **PowerShell profile** on Windows. After applying, reload the shell (or open a new terminal) and the `cl-*` commands are available directly.

### Using the launchers on Windows (PowerShell)

On Windows the launchers are **PowerShell functions**, written to the PowerShell 7 profile:

```
%USERPROFILE%\Documents\PowerShell\Microsoft.PowerShell_profile.ps1
```

After `clp apply`, reload with `. $PROFILE` (or open a new tab), then run `cl-work` directly. Three things to get right:

- **Use PowerShell 7 (`pwsh`), not Windows PowerShell 5.1.** clp writes to the `Documents\PowerShell\` profile (PS7). The old built-in "Windows PowerShell" (5.1, `powershell.exe`) reads a *different* file (`Documents\WindowsPowerShell\`) and won't see the functions. Install PS7 with `winget install --id Microsoft.PowerShell` and make it your default: Windows Terminal → Settings → Startup → Default profile → **PowerShell**. Check with `$PSVersionTable.PSVersion` (want 7.x). *(CMD and Git Bash can't use these — they're PowerShell functions.)*
- **Allow the profile to run.** If reloading errors with "running scripts is disabled," run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **Watch for OneDrive-redirected Documents.** If your Documents folder syncs to OneDrive, PowerShell's real `$PROFILE` may live under OneDrive. Compare `$PROFILE` in your shell against the path above — if they differ, that's why the launcher isn't found.

### Point a profile at a custom LLM provider

Run a profile against z.ai (GLM), mimo, OpenRouter, or any Anthropic-compatible
endpoint — Claude Code reads the provider config from that profile's `settings.json`,
and `clp` manages it for you. The easiest path is the **web dashboard**: open a profile
→ **Edit → Provider**, pick a preset (or *Custom*), fill in the base URL, choose a
keychain secret for the auth token, and optionally map the opus/sonnet/haiku model
names. You can also **copy provider settings from another profile** in one click.

Already configured a provider by hand in `settings.json`? `clp adopt` imports it, and
`clp secrets migrate` moves the plaintext token into your keychain (the manifest then
references it as `secret://…`, resolved at apply time):

```bash
clp adopt --yes          # imports each profile's settings.json env, incl. provider config
clp secrets migrate      # moves ANTHROPIC_AUTH_TOKEN / API_KEY into the keychain
clp doctor               # flags any provider token still sitting in plaintext
```

Under the hood this is a generic per-profile env map written into `settings.json`
(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_*_MODEL`, …), so
anything Claude Code supports works — the form just gives the common keys friendly
labels and a preset for the base URL. It travels with sync and bundles like everything
else, token included (via the encrypted secrets channel).

### Where secrets are stored (per-OS setup)

`clp` keeps API tokens out of your rc/config files by putting them in the OS credential store, picked automatically:

| OS | Backend | Setup |
|---|---|---|
| macOS | Keychain | automatic |
| Windows | DPAPI (via PowerShell) | automatic |
| **Linux desktop** | `secret-tool` (libsecret) | `sudo apt install libsecret-tools` (or `dnf install libsecret`) — needs a running keyring daemon (GNOME Keyring / KWallet) |
| **Linux headless / server** | AES‑256‑GCM encrypted file | set a passphrase (below) — servers have no keyring daemon, so libsecret isn't an option |

**Headless Linux / server (no desktop keyring):** the encrypted-file backend needs a passphrase in the environment. `clp` (and `clp ui`) read it at launch:

```bash
# add to ~/.bashrc so it persists, then: source ~/.bashrc
export CCPROFILES_PASSPHRASE='a-long-passphrase-you-will-remember'
clp ui
```

Secrets then encrypt to `~/.ccprofiles/secrets.enc`. **The passphrase is the decryption key** — keep it safe and unchanged, or the stored secrets become unreadable. (Prefer a systemd `EnvironmentFile` or your secrets manager over `.bashrc` if the box is shared.) Without a keyring *and* without this passphrase, the Secrets tab and `clp secrets …` will report the backend is unavailable.

### Replicate to a second machine

```bash
# machine A (source of truth)
clp serve --allow-secrets
# → ccprofiles sync server on port 51234
# → pairing PIN: 123456

# machine B
clp pair 192.168.1.10 --port 51234 --pin 123456 --name mac
clp sync --from mac --with-secrets
```

Manifest, MCP servers, skills, commands, launcher functions, and (opt-in) secrets all arrive — rendered for the local OS: PowerShell profile functions and junctions on Windows, `.zshrc`/`.bashrc` functions and symlinks elsewhere.

Two things intentionally don't travel:

- **OAuth sessions** — you still run `/login` once per account on the new machine (Anthropic session state is machine-bound; syncing it would be wrong).
- The **`default` profile has no `cl-*` launcher** — it's what plain `claude` already launches; only the named profiles get launcher functions.

## Web dashboard

```bash
clp ui                   # opens http://127.0.0.1:<port>/?t=<token> in your browser
```

A local panel to manage everything the CLI does — and the easiest way to set profiles up:

- **Profiles** — create, edit, and delete profiles from a form: launcher function, environment variables, links, MCP toggles, and a **guided Provider section** (preset picker for z.ai / mimo / OpenRouter / Anthropic-default / Custom, labeled base-URL / token / model fields, copy-from-another-profile, and an *Advanced* raw editor for any other `settings.json` env var). Deleting a profile is manifest-only — the `~/.claude-*` directory stays on disk.
- **Shell RC** — preview the managed block in your `.zshrc`/`.bashrc` vs. what the manifest renders, with a one-click update.
- **MCP servers** (interactive drift matrix), **Secrets** (add / reveal / delete / migrate, plus attach a secret to a profile as an env var), **Sync**, and **Doctor**.

It's **localhost-only** and guarded by a per-launch session token plus an Origin check, so nothing off your machine (and no website in your browser) can reach the API. Pass `--no-open` to just print the URL, or `--port <n>` to pin the port.

## How it works

Three layers of state:

1. **Live state** — your actual `.claude*` dirs and shell rc files. Claude Code owns these; the tool edits only the keys it manages (`mcpServers` and the `env` block in `settings.json`, its marked rc block, its links).
2. **Manifest** — `~/.ccprofiles/manifest.yaml`, a platform-neutral declaration (paths templated as `{home}`, secrets referenced as `secret://name`). Versioned with local git commits; safe to share.
3. **Secrets store** — per-machine keychain: macOS Keychain, Linux `secret-tool` (libsecret), or an AES-256-GCM encrypted file as fallback (native Windows and headless Linux — set `CCPROFILES_PASSPHRASE` in your environment for it). Values never appear in the manifest, bundles, or rc files; launcher functions resolve them at run time by calling the CLI.

> ⚠️ `clp secrets set <name> <value>` takes the value as an argument, which lands in your shell history — prefer `clp secrets migrate` (reads from rc files) or clear history after. Interactive prompting is on the roadmap.

`clp status` shows drift between manifest and live; `clp apply` reconciles (with backups under `~/.ccprofiles/backups/`); `clp snapshot` goes the other way (live → manifest).

### Sync security model

Pairing performs an X25519 ECDH key exchange authenticated by the 6-digit PIN shown on the serving device (HMAC confirmation both ways — a MITM on your network cannot complete pairing without the PIN, and the client verifies the server too). All subsequent payloads are AES-256-GCM encrypted with the pairing key. Secrets transfer additionally requires the server to opt in with `--allow-secrets`, and values go straight into the receiving machine's keychain. Pairing locks after 5 wrong PINs.

## Commands

| Area | Commands |
|---|---|
| Profiles | `list` · `create <name> [--from p]` · `adopt [--yes]` · `doctor` (create/edit/delete + provider config: use `clp ui`) |
| MCP | `mcp list` · `mcp add/rm <name> [--profile p\|--all]` · `mcp sync --from p --to p1,p2\|--all` |
| Secrets | `secrets set/get/list/rm` · `secrets migrate` |
| Manifest | `status` · `apply` · `snapshot` |
| Sync | `serve [--allow-secrets]` · `pair <host> --port n --pin p` · `devices` · `sync --from dev [--with-secrets]` |
| Bundle | `export <file>` · `import <file>` |
| Dashboard | `ui [--port n] [--no-open]` |

All mutating commands support `--dry-run`. Every mutation backs up the files it touches to `~/.ccprofiles/backups/<timestamp>/` first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `error: no manifest yet` | Run `clp adopt --yes` first — it builds the manifest from your existing profiles |
| `zsh: command not found: clp` | Not linked/installed — see Install; if just linked, run `rehash` |
| ``cannot reach <host> — is `ccprofiles serve` running?`` | Start `clp serve` on the other device; check you're on the same network and the port matches |
| `encrypted-file backend requires a passphrase` / secrets tab errors | No OS keyring available. **Linux desktop:** `sudo apt install libsecret-tools` + a running keyring. **Headless Linux / server:** `export CCPROFILES_PASSPHRASE='…'` before `clp ui` (persist in `~/.bashrc`). **Windows:** secrets use DPAPI automatically (needs PowerShell). See [Where secrets are stored](#where-secrets-are-stored-per-os-setup) |
| `cl-*` launcher not found on Windows | Use PowerShell 7 (`pwsh`), not Windows PowerShell 5.1; reload with `. $PROFILE`; if scripts are blocked run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Confirm `$PROFILE` matches `Documents\PowerShell\Microsoft.PowerShell_profile.ps1` (OneDrive can redirect it) |
| Profile shows account `-` after sync | Expected — run `/login` inside that profile once; OAuth sessions don't sync |
| Something went wrong after `apply` | Restore from `~/.ccprofiles/backups/<latest>/` |

## Roadmap

- mDNS auto-discovery for `clp devices`
- Pair devices from the dashboard (currently CLI-only)
- Interactive prompts (`secrets set` without echoing, `adopt` confirmation)

## Development

npm-workspaces monorepo: `packages/core` (library) + `packages/cli` (commander wrapper) + `packages/ui` (dashboard). The published CLI is [`claude-account-sync`](https://www.npmjs.com/package/claude-account-sync); the library is [`ccprofiles-core`](https://www.npmjs.com/package/ccprofiles-core).

```bash
npm install
npm test        # vitest — unit + e2e (incl. an in-process two-machine sync test)
npm run build   # builds core + cli + the dashboard, bundled into the CLI
```

## License

MIT
