# ccprofiles

**Profile manager for Claude Code and OpenAI Codex multi-account setups.**

Run Claude Code with several accounts — personal subscription, work OAuth, API key, alternative providers — each in its own `CLAUDE_CONFIG_DIR`? Then you know the pain: MCP server lists drift apart, skills get shared via hand-made symlinks, API keys end up in plaintext in your `.zshrc`, and setting up a second machine means an afternoon of copy-paste.

The `clp` command (also available as `ccprofiles`) fixes that:

- 🔎 **Adopt** existing `.claude*` and `.codex*` homes into one declarative manifest — zero manual config
- 🎛️ **Set up profiles the easy way** — a guided web form to create, edit, and delete profiles: launcher, env, links, MCP, and provider — no hand-editing config files
- 🌐 **Custom LLM providers per profile** — point a profile at z.ai (GLM), mimo, OpenRouter, or any Anthropic-compatible endpoint with a preset picker; base URL + token + model mappings managed for you, token kept in the keychain
- 🧩 **Manage MCP servers** across profiles: drift matrix, add/remove everywhere at once, sync one profile's set to others
- 🔌 **Manage plugins the same way** — a plugin × profile matrix driving the official `claude plugin` installer, so e.g. `claude-mem` runs on exactly one profile while `superpowers` runs everywhere
- 🔁 **Hand off a session across agents** — `cl-work handoff codex-work` opens the other agent seeded with the current project's latest session transcript
- 🔑 **Pick how Anthropic authenticates per profile** — CLI login, API key, or auth token, from the CLI or the dashboard, token kept in the keychain
- 🔐 **Secrets out of your rc files** — macOS Keychain / libsecret / encrypted file, with `clp secrets migrate` to clean up existing plaintext keys
- 🖥️ **Replicate to another machine over LAN** — PIN pairing, end-to-end encrypted, no cloud, works macOS ↔ Windows ↔ Linux ↔ WSL
- 🖼️ **Web dashboard** — `clp ui` opens a local browser panel to manage everything visually
- 📦 **Offline bundles** for the no-network case (`clp export setup.ccb`)
- 🛟 **Safe by design**: surgical config edits only, automatic backups, and opt-in session sharing with migration backups

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
clp adopt --yes          # REQUIRED FIRST: scan ~/.claude* + ~/.codex* and build manifest
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

The matrix and every `add`/`rm`/`sync` span **both agents** — sync a Claude profile's server set onto a Codex profile and it lands in that Codex home's `config.toml` (TOML-translated), and vice versa.

> **Scope:** `clp` manages **user-scope** MCP servers only, across both Claude (`mcpServers` in `~/.claude.json`) and Codex (`mcp_servers` in `~/.codex*/config.toml`). Project-scoped servers are intentionally left untouched:
> - **Claude** — servers added with `claude mcp add` at its default scope live under `projects[...]` or a project `.mcp.json`; clp never reads them. If one should be managed, re-add it at user scope (`claude mcp add <name> --scope user -- <command>`) then `clp adopt --yes`.
> - **Codex** — it has no project scope, so per-project launchers (identified by a `--project-dir` arg, e.g. code-context-engine's `cce serve --project-dir <path>`) sit in the *same* global table as your real user servers. clp hides these from `clp mcp list` and the drift matrix, and **preserves them on `apply`** — they're never surfaced, synced to other profiles, or deleted.

### Manage plugins (Claude Code)

Plugins work exactly like the MCP matrix — declare per profile, and clp reconciles by driving the official `claude plugin` installer (`marketplace add` + `install`/`uninstall`) with that profile's `CLAUDE_CONFIG_DIR`. No file copying or symlinking.

```bash
clp plugins list                                        # plugin × profile matrix
clp plugins add superpowers@claude-plugins-official --all
clp plugins add claude-mem@thedotmack --profile work    # single-instance plugins on ONE profile
clp plugins add x@mkt --marketplace owner/repo --all    # first use of a new marketplace
clp plugins rm ponytail@ponytail --profile z
clp plugins sync --from oauth --to office               # copy one profile's plugin set
clp plugins apply                                       # make live state match the manifest
```

The dashboard's **Plugins** tab is the same matrix as switches. Notes: the matrix is declarative — a reconcile uninstalls a plugin from profiles where it isn't switched on; reconcile derives "installed" from each profile's `installed_plugins.json` (ground truth), so a stale `enabledPlugins` entry gets properly installed; `claude` must be on PATH; Codex has no plugin system.

### New profile for a new account

```bash
clp create work --from oauth     # dir + launcher fn + copied MCP set
# restart shell, then:
cl-work                          # launches claude with CLAUDE_CONFIG_DIR=~/.claude-work
```

`clp apply` writes a launcher function per profile into your shell startup file — `.zshrc`/`.bashrc` on macOS/Linux, your **PowerShell profile** on Windows. After applying, reload the shell (or open a new terminal) and the `cl-*` commands are available directly.

For Codex, select agent in dashboard or pass `--agent codex`:

```bash
clp create work --agent codex
# restart shell, then:
cx-work                          # launches codex with CODEX_HOME=~/.codex-work
cx-work login                    # signs in inside that CODEX_HOME
```

Codex homes use `config.toml` MCP tables and file-backed `auth.json`; ccprofiles never copies auth into manifest. Set `cli_auth_credentials_store = "file"` per Codex home when strict account isolation is required—OS keyring storage can otherwise remain shared.

### Share resumable sessions across profiles

Session sharing is opt-in per profile. First enable moves existing history into `~/.ccprofiles/shared/`, takes a backup, and links each enabled profile to the pool:

```bash
clp sessions share work          # Claude: projects, todos, shell snapshots
clp sessions share codex-work    # Codex: sessions
clp sessions list
```

Resume from the same project under another account:

```bash
cl-other --resume                # Claude session picker
cx-other resume                  # Codex picker, filtered to current directory
cx-other resume --last           # most recent Codex session in current directory
```

Use `clp sessions unshare <profile>` to restore a local snapshot while leaving shared pool intact. Dashboard exposes same toggle in profile editor and lists both Claude and Codex sessions with full resume IDs.

### Hand off a session to the other agent

Continue the current project's work on a different profile — even across agents (Claude ↔ Codex). The launcher intercepts `handoff`:

```bash
cl-oauth handoff codex-work      # from a Claude session's project dir
cx-work handoff oauth            # and the reverse
```

It finds your latest session for the current directory, renders the transcript to `~/.ccprofiles/handoffs/<stamp>.md`, and opens the target agent seeded with a prompt pointing at it — a fresh, fully native session on the other side (no fragile session-file translation). Config-only caveats: the target is an explicit profile name, and existing launchers need one `clp apply` to gain the `handoff` verb.

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

**Staying on the plain Anthropic endpoint?** Choose *how* each profile authenticates —
**CLI login**, **API key**, or **auth token** — from the same Provider editor (a 3-way
Authentication selector) or the CLI:

```bash
clp provider list                              # each profile's current auth mode
clp provider anthropic work --api-key          # masked prompt → keychain → settings.json
clp provider anthropic work --auth-token --secret my-token   # reference an existing secret
clp provider anthropic work --login            # clear tokens; sign in with `claude login`
```

The token is prompted without echo (never in argv/shell history), stored in the OS
keychain, and referenced as `secret://…` — resolved only at apply time.

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

Prefer the dashboard? `clp ui` → **Sync** → **Pair device** (host, port, PIN), then pull with a dry-run preview — no CLI needed on the receiving machine.

Manifest, MCP servers, skills, commands, launcher functions, plugin declarations, and (opt-in) secrets all arrive — rendered for the local OS: PowerShell profile functions and junctions on Windows, `.zshrc`/`.bashrc` functions and symlinks elsewhere. Plugins are then **installed to match** via `claude plugin` (needs `claude` on PATH; if that step can't run, `clp plugins apply --all` finishes the job).

Two things intentionally don't travel:

- **Authentication sessions** — conversation history can use opt-in shared pool, but account credentials never travel; sign in once per account on new machine.
- The **`default` profile has no `cl-*` launcher** — it's what plain `claude` already launches; only the named profiles get launcher functions.

## Web dashboard

```bash
clp ui                   # opens http://127.0.0.1:<port>/?t=<token> in your browser
```

A local panel to manage everything the CLI does — and the easiest way to set profiles up:

- **Profiles** — create, edit, and delete profiles from a form: launcher function, environment variables, links, MCP toggles, a **guided Provider section** (preset picker for z.ai / mimo / OpenRouter / Anthropic-default / Custom, labeled base-URL / token / model fields, copy-from-another-profile, and an *Advanced* raw editor for any other `settings.json` env var), and a **Skip permissions** toggle that adds `--dangerously-skip-permissions` to that profile's launcher (⚠ bypasses every confirmation — launcher profiles only). Deleting a profile is manifest-only — the `~/.claude-*` directory stays on disk.
- **Shell RC** — preview the managed block in your `.zshrc`/`.bashrc` vs. what the manifest renders, with a one-click update.
- **Sessions** (Claude + Codex shared-history viewer with an in-dashboard transcript reader), **MCP servers** and **Plugins** (interactive matrices), **Secrets** (add / reveal / delete / migrate, plus attach a secret to a profile as an env var), **Sync** (pair devices and pull, with a dry-run preview before applying), and **Doctor**.
- **Dark mode** — follows your OS theme, with a persisted toggle in the sidebar. Destructive actions (sync-to-all, skip-permissions, secret detach/delete) ask for confirmation.

It's **localhost-only** and guarded by a per-launch session token plus an Origin check, so nothing off your machine (and no website in your browser) can reach the API. Pass `--no-open` to just print the URL, or `--port <n>` to pin the port.

## How it works

Three layers of state:

1. **Live state** — actual `.claude*` / `.codex*` dirs and shell rc files. Tool edits only managed MCP tables (`mcpServers` JSON or `mcp_servers` TOML), Claude `settings.json` env, marked rc block, and declared links.
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
| Plugins | `plugins list` · `plugins add/rm <id> [--profile p\|--all] [--marketplace src]` · `plugins sync --from p --to p1,p2\|--all` · `plugins apply [--profile p\|--all]` |
| Provider | `provider list` · `provider anthropic <profile> --login\|--api-key\|--auth-token [--secret name]` |
| Secrets | `secrets set/get/list/rm` (set prompts without echo) · `secrets migrate` |
| Manifest | `status` · `apply` · `snapshot` |
| Sessions | `sessions share <profile>` · `sessions unshare <profile>` · `sessions list` |
| Handoff | `handoff --from p --to p [--print]` (usually via the launcher: `cl-work handoff codex-work`) |
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
- Interactive prompts (`secrets set` without echoing, `adopt` confirmation)

## Development

npm-workspaces monorepo: `packages/core` (library) + `packages/cli` (commander wrapper) + `packages/ui` (dashboard). The published CLI is [`claude-account-sync`](https://www.npmjs.com/package/claude-account-sync); the library is [`ccprofiles-core`](https://www.npmjs.com/package/ccprofiles-core).

```bash
npm install
npm test        # vitest — unit + e2e (incl. an in-process two-machine sync test)
npm run build   # builds core + cli + the dashboard, bundled into the CLI
```

Root `package.json` pins `vite` to `8.1.4` via `overrides` so every workspace resolves the exact same (patched) build tool instead of whatever range each transitive dependency requests — avoids duplicate installs and keeps `packages/ui`'s dev server on a known-good version. Bump it deliberately when a newer vite is verified against the dashboard build.

## Support

If ccprofiles saves you time, [buy me a coffee on Ko-fi](https://ko-fi.com/teukufadh).

## License

MIT
