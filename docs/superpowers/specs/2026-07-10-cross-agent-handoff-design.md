# Cross-agent session handoff — design

Date: 2026-07-10
Status: Approved (design), pending implementation plan

## Problem

Sessions live per agent and can't be resumed across agents: a Claude session
can't be continued in Codex or vice versa. True cross-resume (making
`claude --resume` / `codex resume` read the other's session file) is hard and
fragile — both session formats are internal, undocumented, version-churny;
tool namespaces differ (a Claude turn "called" `Edit`/`Bash`, which Codex has
no equivalent for); and the resumed thread runs on a different model.

A **handoff** sidesteps all of that: brief the target agent with the prior
session's transcript in a fresh, native session on that agent. The transcript
reader already normalizes both agents into one shape (`readSessionTranscript`
→ `SessionTranscript` with `TranscriptEntry[]`), so the read-and-unify half is
done.

## Goal

`cl-oauth handoff codex-work` (and the reverse `cx-work handoff oauth`):
auto-detect the current project's most recent session for the source profile,
render its transcript to a file, and **open the target agent** seeded with a
prompt that points at that file — so the user just runs one command.

## Decisions (from brainstorming)

- **Injection:** render the full normalized transcript to a markdown file, then
  launch the target agent with a short seed prompt referencing the file. No LLM
  summary call; deterministic.
- **Target resolution:** explicit profile name (`handoff <profile>`), validated
  against the manifest. Not agent-keyword inference.
- **Invocation:** the launcher shell function intercepts `handoff <target>` as
  its first arg and calls `ccprofiles handoff --from <thisProfile> --to <target>`.
- **Session scope:** the newest session for the source profile in the current
  cwd. No session in cwd → error.

## Architecture

### 1. Launcher intercept (`rcblock.ts`)

Each launcher gets a `handoff` guard as the **first** line inside the function,
before the env exports (so a handoff never triggers `secrets get`):

POSIX:
```sh
cl-oauth() {
  if [ "$1" = handoff ]; then shift; command ccprofiles handoff --from oauth --to "$1"; return; fi
  export KEY="$(ccprofiles secrets get ...)"          # existing env
  CLAUDE_CONFIG_DIR="$HOME/.claude-oauth" claude "$@"
}
```

PowerShell:
```powershell
function cl-oauth {
  if ($args[0] -eq 'handoff') { ccprofiles handoff --from oauth --to $args[1]; return }
  $env:KEY = (ccprofiles secrets get ...)
  $env:CLAUDE_CONFIG_DIR = "$HOME/.claude-oauth"; claude @args
}
```

- `--from` is bound to the owning profile name at render time.
- Added to **both** Claude and Codex launchers (so reverse handoff works).
- The `default` profile has no launcher, so it can't be a handoff *source* via a
  launcher — acceptable (it's `claude` with no wrapper). It can still be a
  *target* by name.
- Requires one `clp apply` to refresh existing launchers (documented;
  auto-detecting a stale launcher is out of scope).

### 2. `ccprofiles handoff --from <src> --to <target> [--print]`

Flow:
1. Load manifest; resolve `src` and `target` profiles (name, dir, agent).
   Errors: unknown `src`/`target`; `src === target`.
2. `cwd = process.cwd()`.
3. Find the newest source session for this cwd:
   - Build the profiles list; run `scanSessions({ sharedRoot, profiles })`.
   - `src`'s effective scope is its profile name, or `shared` if its session
     dir (`projects/` for claude, `sessions/` for codex) is a symlink into the
     pool.
   - Pick the newest entry (sessions are returned newest-first per project)
     where `project === cwd`, `scope === srcScope`, `agent === src.agent`.
   - None → error: `no <src> session found for this project (<cwd>)`.
4. `readSessionTranscript({ sharedRoot, profiles, agent: src.agent, scope, id })`
   → `SessionTranscript`. Null → error.
5. `renderHandoffMarkdown(transcript)` → write to
   `<manifestRoot>/handoffs/<stamp>-<srcId>.md` (dir auto-created; the CLI
   supplies a filesystem-safe UTC timestamp, keeping the core renderer pure).
6. Build the target launch (pure `buildHandoffLaunch`, then the CLI spawns):
   - `command`: `codex` if target agent is codex, else `claude`.
   - `env`: `{ ...process.env, [homeVar]: targetDir, ...resolvedTargetEnv }`
     where `homeVar` = `CODEX_HOME` (codex) / `CLAUDE_CONFIG_DIR` (claude), and
     `resolvedTargetEnv` = target profile `env` with `secret://` refs resolved
     via the secrets store.
   - `args`: `[skipFlag?, seedPrompt]` — `skipFlag` is
     `--dangerously-bypass-approvals-and-sandbox` (codex) /
     `--dangerously-skip-permissions` (claude) when the target profile sets
     `skipPermissions`, else omitted. `seedPrompt`:
     `Continuing a session handed off from '<src>' (<srcAgent>). The full prior transcript is at <path>. Read it, then pick up where it left off.`
   - `cwd`: current cwd.
7. `--print` (dry-run): write the file, then print the file path and the
   resolved `{ command, args, env-additions, cwd }` instead of spawning. Used
   by tests and for preview. Without `--print`, spawn with `stdio: 'inherit'`;
   on exit, control returns to the shell.

### 3. Renderer (`renderHandoffMarkdown`)

Pure function `SessionTranscript → string`:
- Header block: source agent, project path, session id.
- Each `TranscriptEntry`: `## User` / `## Assistant` / `## Tool — <label>`
  followed by its `text`. Text is already capped (`MAX_ENTRY_CHARS`) by the
  reader.

## Files / units

- **Create `packages/core/src/handoff.ts`**:
  - `findLastSessionForCwd(scanned: ProjectSessions[], cwd, scope, agent)` →
    `{ scope; id } | null` (newest match).
  - `renderHandoffMarkdown(t: SessionTranscript): string`.
  - `buildHandoffLaunch(opts: { agent, targetDir, targetEnv, skipPermissions, seedPromptPath, srcName, srcAgent, cwd }): { command: string; args: string[]; env: Record<string,string>; cwd: string }`
    — pure, no spawning, no secrets I/O (takes already-resolved `targetEnv`).
- **Create `packages/cli/src/commands/handoff.ts`**: the `handoff` command;
  resolves profiles + target env/secrets (reuse `resolveSettingsEnv`-style path
  / the existing secrets store), calls core, writes the file, spawns or prints.
- **Modify `packages/cli/src/context.ts`**: register `registerHandoffCommands`.
- **Modify `packages/core/src/rcblock.ts`**: the intercept line in
  `renderPosix` / `renderPwsh`.
- **Export** the new core symbols via `packages/core/src/index.ts`.

## Testing (vitest, sandboxed home)

- **rcblock**: POSIX and PowerShell launchers render the `handoff` intercept for
  a Claude and a Codex profile; `--from` bound to the profile name; the guard
  precedes the env exports.
- **core**:
  - `findLastSessionForCwd` picks the newest session in the target cwd, not one
    from a different project.
  - `renderHandoffMarkdown` output shape (headers + role sections).
  - `buildHandoffLaunch` produces the correct `command`, home-var, skip flag,
    and merged env for a Claude target and a Codex target (incl. a secret-
    resolved env var and `skipPermissions` on/off).
- **cli e2e (sandbox)**: seed a source session in a sandbox cwd → run
  `handoff --from a --to b --print` → assert the handoff file was written with
  the transcript content, and the printed command targets `b` with the right
  `CODEX_HOME`/`CLAUDE_CONFIG_DIR` and a seed prompt referencing the file.

## Edge cases

- `src === target`, unknown `src`/`target` → clear errors.
- No session in cwd for src → error naming the cwd.
- Handoff dir auto-created.
- Missing target binary → spawn error surfaces naturally (not pre-checked).
- `default` profile has no launcher → can't be a launcher-invoked source; still
  a valid `--to` target.

## Out of scope (v1)

- True native cross-resume (translating into the target's session file).
- LLM summarization of the transcript.
- Agent-keyword target inference / interactive target picking.
- Reminding the user to `clp apply` when a launcher is stale.
