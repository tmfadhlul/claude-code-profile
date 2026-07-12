# ccprofiles-core

Core library powering [`claude-account-sync`](https://www.npmjs.com/package/claude-account-sync) — the `clp` / `ccprofiles` CLI for managing multiple Claude Code and OpenAI Codex accounts.

It provides the discovery, manifest, secrets, apply, and LAN-sync logic used by the CLI and its dashboard.

- Adopts existing `.claude*` / `.codex*` homes into a declarative manifest
- Applies profile config (launchers, env, links, MCP servers) with surgical, backed-up edits
- Reads/writes secrets across macOS Keychain, libsecret, and encrypted-file backends
- Computes MCP server drift across profiles and both agents (Claude + Codex)
- Drives encrypted, PIN-paired LAN replication between machines

Repo: [github.com/tmfadhlul/claude-code-profile](https://github.com/tmfadhlul/claude-code-profile)

Most users want the CLI, not this library — install `claude-account-sync` (`npm install -g claude-account-sync`) instead unless you're building on top of ccprofiles' internals.
