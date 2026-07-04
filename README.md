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

## Quickstart

```bash
npm install -g ccprofiles

ccp adopt --yes          # scan ~/.claude* and build the manifest
ccp list                 # see all your profiles
ccp doctor               # find broken links & plaintext keys
ccp secrets migrate      # move API keys from .zshrc into the OS keychain
```

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

## How it works

Three layers of state:

1. **Live state** — your actual `.claude*` dirs and shell rc files. Claude Code owns these; ccprofiles edits only the keys it manages (`mcpServers`, its marked rc block, its links).
2. **Manifest** — `~/.ccprofiles/manifest.yaml`, a platform-neutral declaration (paths templated as `{home}`, secrets referenced as `secret://name`). Versioned with local git commits; safe to share.
3. **Secrets store** — per-machine keychain. Values never appear in the manifest, bundles, or rc files; launchers resolve them at run time via `ccp secrets get`.

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

All mutating commands support `--dry-run`.

## Development

npm-workspaces monorepo: `packages/core` (library) + `packages/cli` (commander wrapper).

```bash
npm install
npm test        # vitest — unit + e2e (incl. an in-process two-machine sync test)
npm run build
```

## License

MIT
