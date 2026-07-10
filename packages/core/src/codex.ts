import { readFile } from 'node:fs/promises'
import { parse, stringify } from 'smol-toml'
import type { McpServerDef } from './manifest.js'
import { atomicWrite } from './fsutil.js'

type TomlTable = Record<string, unknown>

export async function readCodexMcpServers(configPath: string): Promise<Record<string, McpServerDef>> {
  let config: TomlTable
  try { config = parse(await readFile(configPath, 'utf8')) as TomlTable } catch { return {} }
  const raw = config.mcp_servers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw as TomlTable)
    .filter((entry): entry is [string, McpServerDef] => {
      const value = entry[1]
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && (typeof (value as TomlTable).command === 'string' || typeof (value as TomlTable).url === 'string')
    }))
}

export async function writeCodexMcpServers(configPath: string, servers: Record<string, McpServerDef>): Promise<void> {
  let config: TomlTable = {}
  try { config = parse(await readFile(configPath, 'utf8')) as TomlTable } catch { /* new config */ }
  config.mcp_servers = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const { type: _claudeTransportType, ...codexServer } = server
    return [name, codexServer]
  }))
  await atomicWrite(configPath, stringify(config))
}
