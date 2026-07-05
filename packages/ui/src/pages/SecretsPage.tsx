import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import type { ProfileRow } from '@/components/ProfileEditor'

const SECRET_PREFIX = 'secret://'
type Usage = { profile: string; envKey: string; map: 'env' | 'settingsEnv' }

export function SecretsPage() {
  const [names, setNames] = useState<string[]>([]); const [backend, setBackend] = useState('')
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [shown, setShown] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false); const [f, setF] = useState({ name: '', value: '' })
  const [attaching, setAttaching] = useState<string | null>(null)
  const [att, setAtt] = useState({ profile: '', envKey: 'ANTHROPIC_API_KEY' })

  const load = async () => {
    try { const r = await api.secrets(); setNames(r.names); setBackend(r.backend) } catch (e: any) { toast.error(e.message) }
    try { setProfiles(await api.profiles()) } catch { setProfiles([]) }
  }
  useEffect(() => { load() }, [])

  const usage = (secret: string): Usage[] =>
    profiles.flatMap(p => [
      ...Object.entries(p.env)
        .filter(([, v]) => v === SECRET_PREFIX + secret)
        .map(([envKey]) => ({ profile: p.name, envKey, map: 'env' as const })),
      ...Object.entries(p.settingsEnv)
        .filter(([, v]) => v === SECRET_PREFIX + secret)
        .map(([envKey]) => ({ profile: p.name, envKey, map: 'settingsEnv' as const })),
    ])

  const reveal = async (n: string) => {
    if (shown[n] !== undefined) { const c = { ...shown }; delete c[n]; setShown(c); return }
    try { const r = await api.revealSecret(n); setShown({ ...shown, [n]: r.value }) } catch (e: any) { toast.error(e.message) }
  }

  const attach = async () => {
    if (!attaching || !att.profile || !att.envKey.trim()) return
    const p = profiles.find(x => x.name === att.profile)
    if (!p) return
    try {
      await api.patchProfile(p.name, { env: { ...p.env, [att.envKey.trim()]: SECRET_PREFIX + attaching } })
      toast.success(`Attached ${attaching} to ${p.name} as ${att.envKey.trim()}`)
      setAttaching(null); setAtt({ profile: '', envKey: 'ANTHROPIC_API_KEY' }); load()
    } catch (e: any) { toast.error(e.message) }
  }

  const detach = async (secret: string, u: Usage) => {
    const p = profiles.find(x => x.name === u.profile)
    if (!p) return
    const patch = u.map === 'env'
      ? { env: (() => { const env = { ...p.env }; delete env[u.envKey]; return env })() }
      : { settingsEnv: (() => { const settingsEnv = { ...p.settingsEnv }; delete settingsEnv[u.envKey]; return settingsEnv })() }
    try { await api.patchProfile(p.name, patch); toast.success(`Detached ${secret} from ${u.profile}`); load() }
    catch (e: any) { toast.error(e.message) }
  }

  const adopted = profiles.filter(p => p.adopted)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">Secrets <Badge variant="secondary">{backend}</Badge></h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={async () => {
            try { const r = await api.migrate(); toast.success(r.migrated.length ? `Migrated ${r.migrated.join(', ')}` : 'No plaintext keys found'); load() } catch (e: any) { toast.error(e.message) }
          }}>Migrate plaintext keys</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add secret</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add secret</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5"><Label>Name</Label><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="anthropic-api-key" /></div>
                <div className="space-y-1.5"><Label>Value</Label><Input type="password" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} /></div>
              </div>
              <DialogFooter><Button onClick={async () => {
                try { await api.setSecret(f.name, f.value); toast.success(`Stored ${f.name}`); setOpen(false); setF({ name: '', value: '' }); load() } catch (e: any) { toast.error(e.message) }
              }}>Save</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="divide-y border rounded-lg">
        {names.map(n => {
          const used = usage(n)
          return (
            <div key={n} className="flex items-center justify-between p-3 gap-3">
              <div className="min-w-0">
                <div className="font-mono text-sm">{n}{shown[n] !== undefined && <span className="ml-3 text-muted-foreground">{shown[n]}</span>}</div>
                {used.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {used.map(u => (
                      <Badge key={`${u.profile}-${u.map}-${u.envKey}`} variant="secondary" className="font-mono text-[11px] gap-1">
                        {u.profile} · {u.envKey}{u.map === 'settingsEnv' && <span className="text-muted-foreground"> (settings)</span>}
                        <button className="ml-0.5 hover:text-foreground" title="Detach" onClick={() => detach(n, u)}>×</button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setAttaching(n)}>Attach</Button>
                <Button size="sm" variant="ghost" onClick={() => reveal(n)}>{shown[n] !== undefined ? 'Hide' : 'Reveal'}</Button>
                <Button size="sm" variant="ghost" onClick={async () => { try { await api.rmSecret(n); toast.success(`Removed ${n}`); load() } catch (e: any) { toast.error(e.message) } }}>Delete</Button>
              </div>
            </div>
          )
        })}
        {names.length === 0 && <div className="p-3 text-sm text-muted-foreground">No secrets yet.</div>}
      </div>

      {attaching && (
        <Dialog open onOpenChange={o => { if (!o) setAttaching(null) }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Attach {attaching} to a profile</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Profile</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={att.profile} onChange={e => setAtt({ ...att, profile: e.target.value })}>
                  <option value="">— pick profile —</option>
                  {adopted.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Env var name</Label>
                <Input className="font-mono" value={att.envKey} onChange={e => setAtt({ ...att, envKey: e.target.value })} />
              </div>
              <p className="text-xs text-muted-foreground">
                The launcher will export it as <span className="font-mono">{att.envKey || 'VAR'}="$(ccprofiles secrets get {attaching})"</span> — the value never lands in your rc file.
              </p>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setAttaching(null)}>Cancel</Button>
              <Button disabled={!att.profile || !att.envKey.trim()} onClick={attach}>Attach</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
