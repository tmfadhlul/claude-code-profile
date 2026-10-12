import { toast } from '@/components/ui/sonner'

// Keep the token in sessionStorage so a refresh still authenticates. A fresh `?t=` wins
// (server restarts mint a new token). Tab-scoped: gone when the tab closes.
const urlToken = new URLSearchParams(location.search).get('t')
let token = urlToken ?? ''
try {
  if (urlToken) sessionStorage.setItem('ccp-token', urlToken)
  else token = sessionStorage.getItem('ccp-token') ?? ''
} catch {}
// Strip the token from the address bar once it's captured — it must not linger in
// history, bookmarks, or anything that reads location.href after boot.
history.replaceState(null, '', location.pathname + location.hash)

let progressSeq = 0

/**
 * Mutations ask the server for progress: it streams one `{step}` line per step, then a final
 * `{status, body}` line. A loading toast shows the current step and elapsed time; it only
 * appears if the request outlasts a blink, and the caller's own success/error toast replaces it.
 */
async function req(method: string, path: string, body?: unknown): Promise<any> {
  const streamed = method !== 'GET'
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-ccp-token': token, ...(streamed && { 'x-ccp-progress': '1' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!streamed || !res.headers.get('content-type')?.includes('ndjson') || !res.body) {
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
    return data
  }

  const id = `progress-${++progressSeq}`
  const started = Date.now()
  let current = 'Working…', steps = 0, shown = false
  const render = () => {
    shown = true
    toast.loading(current, { id, description: `${steps ? `Step ${steps} · ` : ''}${Math.round((Date.now() - started) / 1000)}s` })
  }
  const timer = setInterval(render, 1000)
  const firstPaint = setTimeout(render, 400)

  let final: { status: number; body: any } | null = null
  try {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if ('step' in msg) { current = msg.step; steps++; if (shown) render() }
        else final = msg
      }
    }
  } finally {
    clearInterval(timer); clearTimeout(firstPaint)
    toast.dismiss(id)
  }
  if (!final) throw new Error('connection closed before the server finished — check the terminal running ccprofiles ui')
  if (final.status >= 400) throw new Error(final.body?.error ?? `request failed (${final.status})`)
  return final.body
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
  recentSessions: () => req('GET', '/api/sessions/recent'),
  sessionTranscript: (agent: 'claude' | 'codex', scope: string, id: string) =>
    req('GET', `/api/sessions/${agent}/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`),
  devices: () => req('GET', '/api/devices'),
  pair: (b: { host: string; port: number; pin: string; name?: string }) => req('POST', '/api/pair', b),
  version: () => req('GET', '/api/version'),
  sync: (from: string, withSecrets: boolean, dryRun?: boolean) => req('POST', '/api/sync', { from, withSecrets, dryRun }),
}
