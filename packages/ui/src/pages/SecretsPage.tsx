import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

export function SecretsPage() {
  const [names, setNames] = useState<string[]>([]); const [backend, setBackend] = useState('')
  const [shown, setShown] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false); const [f, setF] = useState({ name: '', value: '' })
  const load = async () => { try { const r = await api.secrets(); setNames(r.names); setBackend(r.backend) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  const reveal = async (n: string) => {
    if (shown[n] !== undefined) { const c = { ...shown }; delete c[n]; setShown(c); return }
    try { const r = await api.revealSecret(n); setShown({ ...shown, [n]: r.value }) } catch (e: any) { toast.error(e.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">Secrets <Badge variant="secondary">{backend}</Badge></h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={async () => {
            try { const r = await api.migrate(); toast.success(r.migrated.length ? `Migrated ${r.migrated.join(', ')}` : 'No plaintext keys found'); load() } catch (e: any) { toast.error(e.message) }
          }}>Migrate from rc</Button>
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
        {names.map(n => (
          <div key={n} className="flex items-center justify-between p-3">
            <div className="font-mono text-sm">{n}{shown[n] !== undefined && <span className="ml-3 text-muted-foreground">{shown[n]}</span>}</div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => reveal(n)}>{shown[n] !== undefined ? 'Hide' : 'Reveal'}</Button>
              <Button size="sm" variant="ghost" onClick={async () => { try { await api.rmSecret(n); toast.success(`Removed ${n}`); load() } catch (e: any) { toast.error(e.message) } }}>Delete</Button>
            </div>
          </div>
        ))}
        {names.length === 0 && <div className="p-3 text-sm text-muted-foreground">No secrets yet.</div>}
      </div>
    </div>
  )
}
