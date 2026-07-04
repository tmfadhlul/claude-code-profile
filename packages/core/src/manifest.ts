import { z } from 'zod'
import YAML from 'yaml'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export class ManifestError extends Error {}

const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  type: z.string().optional(),
  url: z.string().optional(),
}).passthrough()

const ProfileSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  launcher: z.string().nullable(),
  auth: z.enum(['oauth', 'api-key', 'env']),
  env: z.record(z.string()).default({}),
  links: z.record(z.string()).default({}),
  mcp: z.array(z.string()).default([]),
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

export function parseManifest(text: string): Manifest {
  let raw: unknown
  try { raw = YAML.parse(text) } catch (e) { throw new ManifestError(`invalid yaml: ${(e as Error).message}`) }
  const res = ManifestSchema.safeParse(raw)
  if (!res.success) throw new ManifestError(res.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  const m = res.data
  for (const p of m.profiles) for (const name of p.mcp)
    if (!m.mcpServers[name]) throw new ManifestError(`profile "${p.name}" references undefined mcp server "${name}"`)
  return m
}

export function serializeManifest(m: Manifest): string {
  return YAML.stringify(m)
}

export async function loadManifest(root: string): Promise<Manifest> {
  return parseManifest(await readFile(join(root, 'manifest.yaml'), 'utf8'))
}

export async function saveManifest(root: string, m: Manifest): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.yaml'), serializeManifest(m), 'utf8')
  try {
    await exec('git', ['-C', root, 'rev-parse', '--git-dir'])
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-m', 'ccprofiles: update manifest'])
  } catch { /* not a repo or nothing to commit — fine */ }
}
