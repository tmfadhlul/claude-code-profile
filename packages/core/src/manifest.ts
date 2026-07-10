import { z } from 'zod'
import YAML from 'yaml'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
})

const ManifestSchema = z.object({
  version: z.literal(1),
  hub: z.string().nullable(),
  profiles: z.array(ProfileSchema),
  mcpServers: z.record(McpServerSchema),
})

export type McpServerDef = z.infer<typeof McpServerSchema>
export type ProfileDecl = z.infer<typeof ProfileSchema>
export type Manifest = z.infer<typeof ManifestSchema>

// identifiers that get interpolated into shell launcher code must be injection-safe
const SAFE_NAME = /^[A-Za-z0-9_-]+$/          // profile names, launcher names, secret refs
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/ // POSIX/PowerShell env var names
const SHELL_META = /["`$;|&()\n\r<>]/         // chars that could break out of a quoted shell context
const SECRET_PREFIX = 'secret://'

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
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.yaml'), yaml, 'utf8')
  try {
    await exec('git', ['-C', root, 'rev-parse', '--git-dir'])
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-m', 'ccprofiles: update manifest'])
  } catch { /* not a repo or nothing to commit — fine */ }
}
