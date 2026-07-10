import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { splitProviderEnv, mergeProviderEnv } from '@/lib/provider'
import { ProviderForm } from '@/components/ProviderForm'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

export type ProfileRow = {
  name: string; agent: 'claude' | 'codex'; dir: string; auth: string; account: string | null; mcp: number
  launcher: string | null; adopted: boolean
  env: Record<string, string>; links: Record<string, string>; mcpNames: string[]
  settingsEnv: Record<string, string>; liveSettingsEnv: Record<string, string>
  skipPermissions: boolean
  sharedSessions: boolean
}

const SECRET_PREFIX = 'secret://'
type EnvRow = { key: string; value: string; secret: boolean }
type KvRow = { key: string; value: string }

function toEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => value.startsWith(SECRET_PREFIX)
    ? { key, value: value.slice(SECRET_PREFIX.length), secret: true }
    : { key, value, secret: false })
}

function fromEnvRows(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.secret ? SECRET_PREFIX + r.value : r.value
  return out
}

function EnvRowsEditor({ rows, onChange, secretNames, keyPlaceholder }: {
  rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; secretNames: string[]; keyPlaceholder: string
}) {
  const setAt = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => j === i ? { ...r, ...patch } : r))
  return (
    <>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input className="w-56 font-mono text-xs" value={r.key} onChange={e => setAt(i, { key: e.target.value })} placeholder={keyPlaceholder} />
          {r.secret ? (
            <select className="flex-1 border rounded-md h-9 px-2 bg-background text-sm" value={r.value} onChange={e => setAt(i, { value: e.target.value })}>
              <option value="">— pick secret —</option>
              {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : (
            <Input className="flex-1 font-mono text-xs" value={r.value} onChange={e => setAt(i, { value: e.target.value })} />
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
            <input type="checkbox" checked={r.secret} onChange={e => setAt(i, { secret: e.target.checked, value: '' })} />secret
          </label>
          <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}>Add env var</Button>
    </>
  )
}

export function ProfileEditor({ profile, profiles, servers, secretNames, onClose, onSaved }: {
  profile: ProfileRow; profiles: ProfileRow[]; servers: string[]; secretNames: string[]
  onClose: () => void; onSaved: () => void
}) {
  const [launcher, setLauncher] = useState(profile.launcher ?? '')
  const [skipPermissions, setSkipPermissions] = useState(profile.skipPermissions)
  const [sharedSessions, setSharedSessions] = useState(profile.sharedSessions)
  const [env, setEnv] = useState<EnvRow[]>(toEnvRows(profile.env))
  const seeded = Object.keys(profile.settingsEnv).length ? profile.settingsEnv : profile.liveSettingsEnv
  const [pform, setPform] = useState(() => splitProviderEnv(seeded).form)
  const [padv, setPadv] = useState<EnvRow[]>(() => toEnvRows(splitProviderEnv(seeded).advanced))
  const [links, setLinks] = useState<KvRow[]>(Object.entries(profile.links).map(([key, value]) => ({ key, value })))
  const [mcp, setMcp] = useState<string[]>(profile.mcpNames)
  const [saving, setSaving] = useState(false)

  const setLinkAt = (i: number, patch: Partial<KvRow>) => setLinks(links.map((r, j) => j === i ? { ...r, ...patch } : r))

  const save = async () => {
    for (const r of [...env, ...padv]) if (r.secret && !r.value) { toast.error(`pick a secret for ${r.key || 'env var'}`); return }
    setSaving(true)
    try {
      const linksObj: Record<string, string> = {}
      for (const r of links) if (r.key.trim()) linksObj[r.key.trim()] = r.value
      await api.patchProfile(profile.name, {
        env: fromEnvRows(env), settingsEnv: profile.agent === 'claude' ? mergeProviderEnv(pform, fromEnvRows(padv)) : undefined,
        links: linksObj, launcher: launcher.trim() || null,
        skipPermissions: launcher.trim() ? skipPermissions : false,
        sharedSessions,
      })
      for (const s of mcp.filter(s => !profile.mcpNames.includes(s))) await api.addMcp({ name: s, targets: [profile.name] })
      for (const s of profile.mcpNames.filter(s => !mcp.includes(s))) await api.rmMcp(s, [profile.name])
      toast.success(`Saved ${profile.name}`)
      onSaved()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {profile.name}</DialogTitle></DialogHeader>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label>Launcher function</Label>
            <Input value={launcher} onChange={e => setLauncher(e.target.value)} placeholder={`${profile.agent === 'codex' ? 'cx' : 'cl'}-work (empty = no launcher)`} />
          </div>

          <div className="space-y-1.5">
            <label className={cn('flex items-center gap-2 text-sm', !launcher.trim() && 'opacity-50')}>
              <input type="checkbox" checked={skipPermissions} disabled={!launcher.trim()}
                onChange={e => setSkipPermissions(e.target.checked)} />
              Skip all permission prompts (<span className="font-mono text-xs">{profile.agent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions'}</span>)
            </label>
            {!launcher.trim()
              ? <p className="text-xs text-muted-foreground">No launcher — plain <span className="font-mono">{profile.agent}</span> won't use this managed flag.</p>
              : skipPermissions && <p className="text-xs text-red-600 dark:text-red-400">⚠ Bypasses every confirmation — use only for profiles you fully trust.</p>}
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sharedSessions} onChange={e => setSharedSessions(e.target.checked)} />
              Share session history (pool <span className="font-mono text-xs">projects / todos / shell-snapshots</span> with other shared profiles)
            </label>
            <p className="text-xs text-muted-foreground">First enable migrates this profile's existing sessions into the shared pool (a backup is taken).</p>
          </div>

          <div className="space-y-1.5">
            <Label>Launcher env (exported by the shell function)</Label>
            <EnvRowsEditor rows={env} onChange={setEnv} secretNames={secretNames} keyPlaceholder={profile.agent === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} />
          </div>

          {profile.agent === 'claude' && <div className="space-y-1.5">
            <Label>Provider</Label>
            <p className="text-xs text-muted-foreground">Where this profile's Claude Code sends requests — written into settings.json. Secret tokens resolve from the keychain on apply.</p>
            <ProviderForm form={pform} onChange={setPform} secretNames={secretNames}
              copySources={profiles.filter(p => p.name !== profile.name)
                .map(p => ({ name: p.name, env: Object.keys(p.settingsEnv).length ? p.settingsEnv : p.liveSettingsEnv }))
                .filter(s => s.env.ANTHROPIC_BASE_URL)} />
            <details className="pt-1">
              <summary className="text-xs text-muted-foreground cursor-pointer select-none">Advanced — other settings.json env vars ({padv.length})</summary>
              <div className="space-y-1.5 pt-2">
                <EnvRowsEditor rows={padv} onChange={setPadv} secretNames={secretNames} keyPlaceholder="CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" />
              </div>
            </details>
          </div>}

          <div className="space-y-1.5">
            <Label>Links</Label>
            {links.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="w-56 font-mono text-xs" value={r.key} onChange={e => setLinkAt(i, { key: e.target.value })} placeholder="skills" />
                <Input className="flex-1 font-mono text-xs" value={r.value} onChange={e => setLinkAt(i, { value: e.target.value })} placeholder="hub or a path" />
                <Button size="sm" variant="ghost" onClick={() => setLinks(links.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setLinks([...links, { key: '', value: '' }])}>Add link</Button>
          </div>

          <div className="space-y-1.5">
            <Label>MCP servers</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {servers.map(s => (
                <label key={s} className="flex items-center gap-2 text-sm font-mono">
                  <input type="checkbox" checked={mcp.includes(s)}
                    onChange={e => setMcp(e.target.checked ? [...mcp, s] : mcp.filter(x => x !== s))} />{s}
                </label>
              ))}
              {servers.length === 0 && <div className="text-sm text-muted-foreground">No servers in manifest.</div>}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save & apply'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
