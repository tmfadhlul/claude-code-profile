import { z } from 'zod'
import YAML from 'yaml'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomicWrite } from './fsutil.js'
const exec = promisify(execFile)

export class ManifestError extends Error {}

const McpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  type: z.string().optional(),
  url: z.string().optional(),
}).passthrough().refine(
  s => s.command !== undefined || s.url !== undefined,
  { message: 'mcp server must have either "command" (local) or "url" (remote)' },
)

const ProfileSchema = z.object({
  agent: z.enum(['claude', 'codex']).optional(),
  name: z.string().min(1),
  dir: z.string().min(1),
  launcher: z.string().nullable(),
  auth: z.enum(['oauth', 'api-key', 'env']),
  env: z.record(z.string()).default({}),
  links: z.record(z.string()).default({}),
  mcp: z.array(z.string()).default([]),
  settingsEnv: z.record(z.string()).default({}),
  skipPermissions: z.boolean().default(false),
  sharedSessions: z.boolean().default(false),
  plugins: z.array(z.string()).default([]),
})

const MarketplaceSchema = z.object({ source: z.string().min(1) })

const ManifestSchema = z.object({
  version: z.literal(1),
  hub: z.string().nullable(),
  profiles: z.array(ProfileSchema),
  mcpServers: z.record(McpServerSchema),
  marketplaces: z.record(MarketplaceSchema).default({}),
})

export type McpServerDef = z.infer<typeof McpServerSchema>
export type ProfileDecl = z.infer<typeof ProfileSchema>
export type Manifest = z.infer<typeof ManifestSchema>
export type MarketplaceDef = z.infer<typeof MarketplaceSchema>

// identifiers that get interpolated into shell launcher code must be injection-safe
// leading '-' is forbidden (but internal '-' still allowed) so a value can never be parsed as a
// CLI flag when passed as a positional argv entry (e.g. `claude plugin install <id>`)
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/ // profile names, launcher names, secret refs
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/ // POSIX/PowerShell env var names
const SAFE_LINK_ENTRY = /^[A-Za-z0-9._-]+$/     // one profile-dir child; never a path
const SAFE_SOURCE = /^[A-Za-z0-9._@:/][A-Za-z0-9._/@:-]*$/ // marketplace source (interpolated into `claude plugin` shell-out); no leading '-'
const SHELL_META = /["`$;|&()\n\r<>]/         // chars that could break out of a quoted shell context
const SECRET_PREFIX = 'secret://'
// plaintext provider tokens that must never be committed to manifest git history
const PLAINTEXT_TOKEN = /sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/

/**
 * True if `yaml` (raw manifest.yaml text, or any string) contains a plaintext provider
 * token. saveManifest() uses this to decide whether to skip the git commit; doctor checks
 * (CLI + UI) use it to surface that skip as a visible problem instead of a stderr-only warning.
 */
export function manifestHasPlaintextSecret(yaml: string): boolean {
  return PLAINTEXT_TOKEN.test(yaml)
}

/** Reject any path with a literal `..` path-traversal segment, on either `/` or `\` separators. */
function hasDotDotSegment(path: string): boolean {
  return path.split(/[/\\]/).includes('..')
}

/**
 * Reject manifests whose identifiers could break out of the shell launcher context.
 * Applies to every manifest — an untrusted bundle/peer manifest reaches this before
 * anything is written to your rc file or config.
 */
export function assertSafeManifest(m: Manifest): void {
  for (const p of m.profiles) {
    if (!SAFE_NAME.test(p.name)) throw new ManifestError(`unsafe profile name: ${JSON.stringify(p.name)} (allowed: letters, digits, - _)`)
    if (p.launcher !== null && !SAFE_NAME.test(p.launcher)) throw new ManifestError(`unsafe launcher name in profile "${p.name}": ${JSON.stringify(p.launcher)}`)
    if (SHELL_META.test(p.dir)) throw new ManifestError(`unsafe profile dir in profile "${p.name}": ${JSON.stringify(p.dir)}`)
    if (hasDotDotSegment(p.dir)) throw new ManifestError(`unsafe profile dir in profile "${p.name}": ${JSON.stringify(p.dir)} (must not contain a ".." segment)`)
    for (const [k, v] of Object.entries(p.env)) {
      if (!SAFE_ENV_KEY.test(k)) throw new ManifestError(`unsafe env var name in profile "${p.name}": ${JSON.stringify(k)}`)
      if (v.startsWith(SECRET_PREFIX)) {
        const ref = v.slice(SECRET_PREFIX.length)
        if (!SAFE_NAME.test(ref)) throw new ManifestError(`unsafe secret reference in profile "${p.name}": ${JSON.stringify(v)}`)
      }
    }
    for (const [k, v] of Object.entries(p.settingsEnv)) {
      if (!SAFE_ENV_KEY.test(k)) throw new ManifestError(`unsafe settings env var name in profile "${p.name}": ${JSON.stringify(k)}`)
      if (v.startsWith(SECRET_PREFIX)) {
        const ref = v.slice(SECRET_PREFIX.length)
        if (!SAFE_NAME.test(ref)) throw new ManifestError(`unsafe secret reference in profile "${p.name}": ${JSON.stringify(v)}`)
      }
    }
    for (const entry of Object.keys(p.links)) {
      if (!SAFE_LINK_ENTRY.test(entry) || entry === '.' || entry === '..')
        throw new ManifestError(`unsafe link entry in profile "${p.name}": ${JSON.stringify(entry)} (must be one file or directory name)`)
    }
  }
  for (const [name, mk] of Object.entries(m.marketplaces ?? {})) {
    if (!SAFE_NAME.test(name)) throw new ManifestError(`unsafe marketplace name: ${JSON.stringify(name)}`)
    if (!SAFE_SOURCE.test(mk.source)) throw new ManifestError(`unsafe marketplace source for "${name}": ${JSON.stringify(mk.source)}`)
  }
  for (const p of m.profiles) for (const id of p.plugins) {
    const at = id.lastIndexOf('@')
    const nm = at > 0 ? id.slice(0, at) : id, mkt = at > 0 ? id.slice(at + 1) : ''
    if (!SAFE_NAME.test(nm) || !SAFE_NAME.test(mkt)) throw new ManifestError(`unsafe plugin id in profile "${p.name}": ${JSON.stringify(id)}`)
  }
}

export function parseManifest(text: string): Manifest {
  let raw: unknown
  try { raw = YAML.parse(text) } catch (e) { throw new ManifestError(`invalid yaml: ${(e as Error).message}`) }
  const res = ManifestSchema.safeParse(raw)
  if (!res.success) throw new ManifestError(res.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  const m = res.data
  for (const p of m.profiles) for (const name of p.mcp)
    if (!m.mcpServers[name]) throw new ManifestError(`profile "${p.name}" references undefined mcp server "${name}"`)
  for (const p of m.profiles) for (const id of p.plugins) {
    const at = id.lastIndexOf('@')
    const mkt = at > 0 ? id.slice(at + 1) : ''
    if (!mkt || !m.marketplaces[mkt]) throw new ManifestError(`profile "${p.name}" references undefined marketplace for plugin "${id}"`)
  }
  assertSafeManifest(m)
  return m
}

export function serializeManifest(m: Manifest): string {
  return YAML.stringify(m)
}

export async function loadManifest(root: string): Promise<Manifest> {
  return parseManifest(await readFile(join(root, 'manifest.yaml'), 'utf8'))
}

export async function saveManifest(root: string, m: Manifest): Promise<void> {
  const yaml = serializeManifest(m)
  parseManifest(yaml) // guard: never write a manifest that cannot be reloaded
  // manifestRoot also holds secrets.enc/devices.json — lock it down here since this is often
  // the first thing (adopt/manifest init) to create it.
  await mkdir(root, { recursive: true, mode: 0o700 })
  // settingsEnv can carry plaintext secrets until `secrets migrate` runs — write at 0600.
  await atomicWrite(join(root, 'manifest.yaml'), yaml, { mode: 0o600 })
  if (manifestHasPlaintextSecret(yaml)) {
    // never let a plaintext token land in git history — the file is still written above
    // (callers may still need it on disk), we just refuse to commit it.
    process.stderr.write('warn: manifest contains a plaintext secret — skipping git commit; run: ccprofiles secrets migrate\n')
    return
  }
  try {
    await exec('git', ['-C', root, 'rev-parse', '--git-dir'])
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-m', 'ccprofiles: update manifest'])
  } catch (e) {
    if (!isBenignGitError(e)) {
      // manifest.yaml is already written above — don't throw, but don't silently drop history
      // either. Anything other than "not a repo" / "nothing to commit" is a real failure
      // (hook rejection, disk full, corrupt index, ...) the user should know about.
      process.stderr.write(`warn: manifest.yaml written but git commit failed: ${gitErrorMessage(e)}\n`)
    }
    // else: not a git repo, or nothing changed to commit — expected, nothing to report
  }
}

/** True for the two git outcomes saveManifest treats as expected/benign, not a real failure. */
function isBenignGitError(e: unknown): boolean {
  const text = gitErrorMessage(e)
  return /nothing to commit/i.test(text) || /not a git repository/i.test(text)
}

function gitErrorMessage(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string } | undefined
  return [err?.stderr, err?.stdout, err?.message].filter(Boolean).join(' ').trim() || String(e)
}
