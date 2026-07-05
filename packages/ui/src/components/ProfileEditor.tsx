import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { X } from 'lucide-react'

export type ProfileRow = {
  name: string; dir: string; auth: string; account: string | null; mcp: number
  launcher: string | null; adopted: boolean
  env: Record<string, string>; links: Record<string, string>; mcpNames: string[]
}

const SECRET_PREFIX = 'secret://'
type EnvRow = { key: string; value: string; secret: boolean }
type KvRow = { key: string; value: string }

function toEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => value.startsWith(SECRET_PREFIX)
    ? { key, value: value.slice(SECRET_PREFIX.length), secret: true }
    : { key, value, secret: false })
}

export function ProfileEditor({ profile, servers, secretNames, onClose, onSaved }: {
  profile: ProfileRow; servers: string[]; secretNames: string[]
  onClose: () => void; onSaved: () => void
}) {
  const [launcher, setLauncher] = useState(profile.launcher ?? '')
  const [env, setEnv] = useState<EnvRow[]>(toEnvRows(profile.env))
  const [links, setLinks] = useState<KvRow[]>(Object.entries(profile.links).map(([key, value]) => ({ key, value })))
  const [mcp, setMcp] = useState<string[]>(profile.mcpNames)
  const [saving, setSaving] = useState(false)

  const setEnvAt = (i: number, patch: Partial<EnvRow>) => setEnv(env.map((r, j) => j === i ? { ...r, ...patch } : r))
  const setLinkAt = (i: number, patch: Partial<KvRow>) => setLinks(links.map((r, j) => j === i ? { ...r, ...patch } : r))

  const save = async () => {
    const missingSecret = env.find(r => r.secret && !r.value)
    if (missingSecret) { toast.error(`pick a secret for ${missingSecret.key || 'env var'}`); return }
    setSaving(true)
    try {
      const envObj: Record<string, string> = {}
      for (const r of env) if (r.key.trim()) envObj[r.key.trim()] = r.secret ? SECRET_PREFIX + r.value : r.value
      const linksObj: Record<string, string> = {}
      for (const r of links) if (r.key.trim()) linksObj[r.key.trim()] = r.value
      await api.patchProfile(profile.name, { env: envObj, links: linksObj, launcher: launcher.trim() || null })
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
            <Input value={launcher} onChange={e => setLauncher(e.target.value)} placeholder="cl-work (empty = no launcher)" />
          </div>

          <div className="space-y-1.5">
            <Label>Environment variables</Label>
            {env.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="w-56 font-mono text-xs" value={r.key} onChange={e => setEnvAt(i, { key: e.target.value })} placeholder="ANTHROPIC_API_KEY" />
                {r.secret ? (
                  <select className="flex-1 border rounded-md h-9 px-2 bg-background text-sm" value={r.value} onChange={e => setEnvAt(i, { value: e.target.value })}>
                    <option value="">— pick secret —</option>
                    {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <Input className="flex-1 font-mono text-xs" value={r.value} onChange={e => setEnvAt(i, { value: e.target.value })} />
                )}
                <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <input type="checkbox" checked={r.secret} onChange={e => setEnvAt(i, { secret: e.target.checked, value: '' })} />secret
                </label>
                <Button size="sm" variant="ghost" onClick={() => setEnv(env.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setEnv([...env, { key: '', value: '', secret: false }])}>Add env var</Button>
          </div>

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
