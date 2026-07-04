# ccprofiles

**Profile manager for [Claude Code](https://claude.com/claude-code) multi-account setups.**

Run Claude Code with several accounts — personal subscription, work OAuth, API key, alternative providers — each in its own `CLAUDE_CONFIG_DIR`? Then you know the pain: MCP server lists drift apart, skills get shared via hand-made symlinks, API keys end up in plaintext in your `.zshrc`, and setting up a second machine means an afternoon of copy-paste.

`ccprofiles` (alias `ccp`) fixes that:

- 🔎 **Adopt** your existing `.claude*` directories into a declarative manifest — zero manual config
- 🧩 **Manage MCP servers** across profiles: drift matrix, add/remove everywhere at once, sync one profile's set to others
- 🔐 **Secrets out of your rc files** — macOS Keychain / libsecret / encrypted file, with `ccp secrets migrate` to clean up existing plaintext keys
- 🖥️ **Replicate to another machine over LAN** — PIN pairing, end-to-end encrypted, no cloud, works macOS ↔ Windows ↔ Linux ↔ WSL
- 📦 **Offline bundles** for the no-network case (`ccp export setup.ccb`)
- 🛟 **Safe by design**: surgical config edits only, automatic backups, `--dry-run` everywhere, never touches your sessions/history

## Install

Requires **Node ≥ 20** (you have it — Claude Code needs it too).

```bash
# from source (not yet on npm)
git clone https://github.com/tmfadhlul/claude-code-profile.git && cd claude-code-profile
npm install && npm run build
npm link --workspace ccprofiles   # or: cd packages/cli && npm link
```

> Using nvm? `npm link` installs into the *active* node version — re-link after `nvm use <other>`.

Once published: `npm install -g ccprofiles`.

## Quickstart

```bash
ccp adopt --yes          # REQUIRED FIRST: scan ~/.claude* and build the manifest
ccp list                 # see all your profiles
ccp doctor               # find broken links & plaintext keys
ccp secrets migrate      # move API keys from .zshrc into the OS keychain
```

Everything except `list`, `adopt`, and `doctor` needs the manifest, so `ccp adopt --yes` is always step one — commands will remind you if you skip it.

### Manage MCP servers

```bash
ccp mcp list                                   # server × profile drift matrix
ccp mcp add shadcn --all --command npx --args "shadcn@latest,mcp"
ccp mcp sync --from oauth --to office,z        # make profiles match
```

### New profile for a new account

```bash
ccp create work --from oauth     # dir + launcher fn + copied MCP set
# restart shell, then:
cl-work                          # launches claude with CLAUDE_CONFIG_DIR=~/.claude-work
```

### Replicate to a second machine

```bash
# machine A (source of truth)
ccp serve --allow-secrets
# → ccprofiles sync server on port 51234
# → pairing PIN: 123456

# machine B
ccp pair 192.168.1.10 --port 51234 --pin 123456 --name mac
ccp sync --from mac --with-secrets
```

Manifest, MCP servers, skills, commands, launcher functions, and (opt-in) secrets all arrive — rendered for the local OS: PowerShell profile functions and junctions on Windows, `.zshrc`/`.bashrc` functions and symlinks elsewhere.

Two things intentionally don't travel:

- **OAuth sessions** — you still run `/login` once per account on the new machine (Anthropic session state is machine-bound; syncing it would be wrong).
- The **`default` profile has no `cl-*` launcher** — it's what plain `claude` already launches; only the named profiles get launcher functions.

## How it works

Three layers of state:

1. **Live state** — your actual `.claude*` dirs and shell rc files. Claude Code owns these; ccprofiles edits only the keys it manages (`mcpServers`, its marked rc block, its links).
2. **Manifest** — `~/.ccprofiles/manifest.yaml`, a platform-neutral declaration (paths templated as `{home}`, secrets referenced as `secret://name`). Versioned with local git commits; safe to share.
3. **Secrets store** — per-machine keychain: macOS Keychain, Linux `secret-tool` (libsecret), or an AES-256-GCM encrypted file as fallback (native Windows and headless Linux — set `CCPROFILES_PASSPHRASE` in your environment for it). Values never appear in the manifest, bundles, or rc files; launchers resolve them at run time via `ccp secrets get`.

> ⚠️ `ccp secrets set <name> <value>` takes the value as an argument, which lands in your shell history — prefer `ccp secrets migrate` (reads from rc files) or clear history after. Interactive prompting is on the roadmap.

`ccp status` shows drift between manifest and live; `ccp apply` reconciles (with backups under `~/.ccprofiles/backups/`); `ccp snapshot` goes the other way (live → manifest).

### Sync security model

Pairing performs an X25519 ECDH key exchange authenticated by the 6-digit PIN shown on the serving device (HMAC confirmation both ways — a MITM on your network cannot complete pairing without the PIN, and the client verifies the server too). All subsequent payloads are AES-256-GCM encrypted with the pairing key. Secrets transfer additionally requires the server to opt in with `--allow-secrets`, and values go straight into the receiving machine's keychain.

## Commands

| Area | Commands |
|---|---|
| Profiles | `list` · `create <name> [--from p]` · `adopt [--yes]` · `doctor` |
| MCP | `mcp list` · `mcp add/rm <name> [--profile p\|--all]` · `mcp sync --from p --to p1,p2\|--all` |
| Secrets | `secrets set/get/list/rm` · `secrets migrate` |
| Manifest | `status` · `apply` · `snapshot` |
| Sync | `serve [--allow-secrets]` · `pair <host> --port n --pin p` · `devices` · `sync --from dev [--with-secrets]` |
| Bundle | `export <file>` · `import <file>` |

All mutating commands support `--dry-run`. Every mutation backs up the files it touches to `~/.ccprofiles/backups/<timestamp>/` first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `error: no manifest yet` | Run `ccp adopt --yes` first — it builds the manifest from your existing profiles |
| `zsh: command not found: ccp` | Not linked/installed — see Install; if just linked, run `rehash` |
| ``cannot reach <host> — is `ccp serve` running?`` | Start `ccp serve` on the other device; check you're on the same network and the port matches |
| `encrypted-file backend requires a passphrase` | Set `CCPROFILES_PASSPHRASE` (Windows / Linux without libsecret) |
| Profile shows account `-` after sync | Expected — run `/login` inside that profile once; OAuth sessions don't sync |
| Something went wrong after `apply` | Restore from `~/.ccprofiles/backups/<latest>/` |

## Roadmap

- Web dashboard on top of `@ccprofiles/core`
- mDNS auto-discovery for `ccp devices`
- Windows Credential Manager (DPAPI) secrets backend
- Interactive prompts (`secrets set` without echoing, `adopt` confirmation)

## Development

npm-workspaces monorepo: `packages/core` (library) + `packages/cli` (commander wrapper).

```bash
npm install
npm test        # vitest — unit + e2e (incl. an in-process two-machine sync test)
npm run build
```

## License

MIT
