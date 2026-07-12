import { readFile } from 'node:fs/promises'
import { parse, stringify } from 'smol-toml'
import type { McpServerDef } from './manifest.js'
import { atomicWrite, backupFiles } from './fsutil.js'

type TomlTable = Record<string, unknown>

/**
 * Codex keeps every MCP server in one flat global `mcp_servers` table with no scope
 * marker, so per-project launchers (e.g. CCE's `cce serve --project-dir <path>`) sit
 * alongside genuine user-scope servers. clp manages user scope only: it neither surfaces
 * nor manages these project launchers — and (see writeCodexMcpServers) never deletes them.
 */
export function isProjectScopedMcpServer(def: McpServerDef): boolean {
  return !!def.args?.some(a => a === '--project-dir' || a.startsWith('--project-dir='))
}

function isMcpServerTable(value: unknown): value is McpServerDef {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (typeof (value as TomlTable).command === 'string' || typeof (value as TomlTable).url === 'string')
}

export async function readCodexMcpServers(configPath: string): Promise<Record<string, McpServerDef>> {
  let config: TomlTable
  try { config = parse(await readFile(configPath, 'utf8')) as TomlTable } catch { return {} }
  const raw = config.mcp_servers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw as TomlTable)
    .filter((entry): entry is [string, McpServerDef] => isMcpServerTable(entry[1]))
    // user scope only — hide per-project launchers from the drift matrix, adopt, and sync
    .filter(([, def]) => !isProjectScopedMcpServer(def)))
}

export async function writeCodexMcpServers(
  configPath: string,
  servers: Record<string, McpServerDef>,
  backup?: { backupRoot: string; stamp: string },
): Promise<void> {
  let config: TomlTable = {}
  try { config = parse(await readFile(configPath, 'utf8')) as TomlTable }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (backup) await backupFiles([configPath], backup.backupRoot, backup.stamp)
      throw new Error(`refusing to overwrite unreadable ${configPath} — back it up and fix it, then re-apply (${(e as Error).message})`)
    }
    // ENOENT: genuinely new config, config stays {}
  }
  // Preserve project-scoped launchers already in the file: clp hides them from management,
  // so a plain replace would silently delete them. Only user-scope servers are clp-managed.
  const existing = config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
    ? (config.mcp_servers as Record<string, unknown>) : {}
  const preserved = Object.fromEntries(Object.entries(existing)
    .filter((e): e is [string, McpServerDef] => isMcpServerTable(e[1]) && isProjectScopedMcpServer(e[1])))
  const managed = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const { type: _claudeTransportType, ...codexServer } = server
    return [name, codexServer]
  }))
  config.mcp_servers = { ...preserved, ...managed }
  await atomicWrite(configPath, stringify(config))
}
