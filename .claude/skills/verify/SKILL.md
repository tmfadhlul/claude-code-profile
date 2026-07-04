---
name: verify
description: Drive the ccprofiles CLI end-to-end in a sandboxed home to verify changes without touching the real ~/.claude* setup or macOS keychain.
---

# Verifying ccprofiles

Build: `npm run build` (tsc -b). The real surface is the built CLI: `node packages/cli/dist/index.js` — rebuild before driving, tests alias core to src but dist does not.

## Sandbox recipe

Everything is isolated via two env vars — no mocks needed:

- `CCPROFILES_TEST_HOME=<dir>` — overrides home (discovery, manifest root, rc file all follow)
- `CCPROFILES_PASSPHRASE=x` — forces the encrypted-file secrets backend, **required on macOS to avoid writing to the real keychain**
- `SHELL=/bin/zsh` (or `/bin/bash`) — controls which rc file is managed

```bash
SB=$(mktemp -d)
mkdir -p $SB/home/.claude
echo '{"mcpServers":{"playwright":{"command":"npx"}}}' > $SB/home/.claude.json
run() { CCPROFILES_TEST_HOME=$SB/home CCPROFILES_PASSPHRASE=pw SHELL=/bin/zsh \
  node packages/cli/dist/index.js "$@"; }
run adopt --yes && run apply && run status   # expect: in sync
```

Gotcha: in zsh, don't put the command in a var (`$CCP list` fails — no word splitting); use a function.

## Flows worth driving

1. **adopt gate**: `run adopt` (no --yes) must not write; `--yes` writes manifest + `.ccprofiles/.gitignore`
2. **doctor**: seed `.zshrc` with `export ANTHROPIC_API_KEY="sk-ant-FAKE"` → doctor warns + exit 1; after `secrets migrate` → `ok`, exit 0, other rc lines untouched
3. **mcp**: `mcp list` matrix, `mcp sync --from a --to b` updates the target's `.claude.json` while preserving foreign JSON keys (seed one to check)
4. **LAN sync**: start `run serve --port 47391 --allow-secrets > serve.log &` (foreground-forever — kill by PID, not %1, if backgrounded from another shell), parse PIN from log, then from a second sandbox home: `pair 127.0.0.1 --port 47391 --pin <pin> --name macA` → `sync --from macA --with-secrets`. Verify: profiles/dirs created, skill files copied, launcher block in target rc uses `$HOME` (portable), secret readable from the *target's* store
5. **bundle**: `export f.ccb` → `import f.ccb` into a third home with `SHELL=/bin/bash` (verifies .bashrc path)

## Good probes

wrong PIN (expect `pin mismatch`, exit 1) · sync from unpaired name · `mcp add unknown` without `--command` · import garbage bundle · pair against a dead port · check `backups/<stamp>/` contains the pre-migrate rc with the original key
