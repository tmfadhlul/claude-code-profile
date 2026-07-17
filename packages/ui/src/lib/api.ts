const token = new URLSearchParams(location.search).get('t') ?? ''
// Strip the token from the address bar once it's captured — it must not linger in
// history, bookmarks, or anything that reads location.href after boot.
history.replaceState(null, '', location.pathname + location.hash)

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-ccp-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  return data
}

export type ProfilePatch = {
  env?: Record<string, string>; links?: Record<string, string>; launcher?: string | null
  settingsEnv?: Record<string, string>; skipPermissions?: boolean; sharedSessions?: boolean
  mcp?: string[]
}

export const api = {
  profiles: () => req('GET', '/api/profiles'),
  adopt: () => req('POST', '/api/adopt'),
  createProfile: (name: string, agent: 'claude' | 'codex', from?: string) => req('POST', '/api/profiles', { name, agent, from }),
  patchProfile: (name: string, patch: ProfilePatch) => req('PATCH', `/api/profiles/${encodeURIComponent(name)}`, patch),
  deleteProfile: (name: string) => req('DELETE', `/api/profiles/${encodeURIComponent(name)}`),
  rc: () => req('GET', '/api/rc'),
  updateRc: () => req('POST', '/api/rc'),
  mcp: () => req('GET', '/api/mcp'),
  addMcp: (b: object) => req('POST', '/api/mcp', b),
  rmMcp: (name: string, targets: unknown) => req('DELETE', `/api/mcp/${encodeURIComponent(name)}`, { targets }),
  syncMcp: (from: string, to: unknown) => req('POST', '/api/mcp/sync', { from, to }),
  plugins: () => req('GET', '/api/plugins'),
  addPlugin: (b: object) => req('POST', '/api/plugins', b),
  rmPlugin: (id: string, targets: unknown) => req('DELETE', `/api/plugins/${encodeURIComponent(id)}`, { targets }),
  syncPlugins: (from: string, to: unknown) => req('POST', '/api/plugins/sync', { from, to }),
  secrets: () => req('GET', '/api/secrets'),
  revealSecret: (n: string) => req('GET', `/api/secrets/${encodeURIComponent(n)}`),
  setSecret: (n: string, value: string) => req('PUT', `/api/secrets/${encodeURIComponent(n)}`, { value }),
  rmSecret: (n: string) => req('DELETE', `/api/secrets/${encodeURIComponent(n)}`),
  migrate: () => req('POST', '/api/secrets/migrate'),
  status: () => req('GET', '/api/status'),
  apply: () => req('POST', '/api/apply'),
  doctor: () => req('GET', '/api/doctor'),
  fix: () => req('POST', '/api/fix'),
  sessions: () => req('GET', '/api/sessions'),
  sessionTranscript: (agent: 'claude' | 'codex', scope: string, id: string) =>
    req('GET', `/api/sessions/${agent}/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`),
  devices: () => req('GET', '/api/devices'),
  pair: (b: { host: string; port: number; pin: string; name?: string }) => req('POST', '/api/pair', b),
  version: () => req('GET', '/api/version'),
  sync: (from: string, withSecrets: boolean, dryRun?: boolean) => req('POST', '/api/sync', { from, withSecrets, dryRun }),
}
