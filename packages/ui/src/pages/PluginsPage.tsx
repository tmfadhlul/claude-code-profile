import { useEffect, useState } from 'react'
import { Boxes, Plus, Puzzle, RefreshCw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type Plugins = { marketplaces: string[]; profiles: { name: string; has: string[] }[] }
export function PluginsPage() {
  const [data, setData] = useState<Plugins | null>(null); const [open, setOpen] = useState(false)
  const [f, setF] = useState({ id: '', source: '' }); const [from, setFrom] = useState(''); const [busy, setBusy] = useState('')
  const load = async () => { try { setData(await api.plugins()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  const ids = data ? Array.from(new Set(data.profiles.flatMap(p => p.has))).sort() : []
  const toggle = async (id: string, profile: string, on: boolean) => { const key = `${id}:${profile}`; setBusy(key); try { on ? await api.addPlugin({ id, targets: [profile] }) : await api.rmPlugin(id, [profile]); await load() } catch (e: any) { toast.error(e.message) } finally { setBusy('') } }

  const addDialog = <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus className="h-4 w-4" /> Add plugin</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Add plugin</DialogTitle><p className="text-sm leading-6 text-muted-foreground">Register one plugin across every managed profile. Fine-tune access from matrix afterward.</p></DialogHeader><div className="space-y-4"><div><Label className="field-label">Plugin ID</Label><Input className="font-mono" value={f.id} onChange={e => setF({ ...f, id: e.target.value })} placeholder="playwright@my-marketplace" autoFocus /></div><div><Label className="field-label">Marketplace source</Label><Input className="font-mono" value={f.source} onChange={e => setF({ ...f, source: e.target.value })} placeholder="github.com/org/marketplace" /></div></div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!f.id.trim() || !f.source.trim()} onClick={async () => { try { await api.addPlugin({ id: f.id.trim(), source: f.source.trim(), targets: 'all' }); toast.success(`Added ${f.id.trim()}`); setOpen(false); setF({ id: '', source: '' }); await load() } catch (e: any) { toast.error(e.message) } }}>Add to all profiles</Button></DialogFooter></DialogContent></Dialog>

  return <>
    <PageHeader eyebrow="Tool access" title="Plugins" description="See exactly which plugins each profile can reach. Toggle assignments without editing configuration files." actions={<>{data && <StatusPill tone="info">{ids.length} plugins</StatusPill>}{addDialog}</>} />
    {!data ? <LoadingState label="Loading plugin assignments" /> : ids.length === 0 ? <EmptyState icon={Boxes} title="No plugins" description="Add a plugin once, then choose which profiles can use it." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add plugin</Button>} /> : <div className="space-y-5">
      <section className="surface-flat flex flex-col gap-3 p-4 sm:flex-row sm:items-center"><div className="flex flex-1 items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-muted"><RefreshCw className="h-4 w-4" /></span><div><p className="text-sm font-bold">Mirror one profile’s plugin set</p><p className="text-xs text-muted-foreground">Replace assignments across all profiles.</p></div></div><select className="select-field sm:w-52" value={from} onChange={e => setFrom(e.target.value)} aria-label="Source profile"><option value="">Choose source…</option>{data.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}</select><Button variant="outline" disabled={!from || busy === 'sync'} onClick={async () => { setBusy('sync'); try { await api.syncPlugins(from, 'all'); toast.success(`Synced from ${from}`); await load() } catch (e: any) { toast.error(e.message) } finally { setBusy('') } }}>{busy === 'sync' ? 'Syncing…' : 'Sync to all'}</Button></section>

      <div className="hidden overflow-x-auto rounded-xl border bg-card md:block"><table className="w-full border-collapse text-sm"><thead><tr className="border-b bg-muted/35"><th className="sticky left-0 z-10 min-w-48 bg-muted px-5 py-3 text-left text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">Plugin</th>{data.profiles.map(p => <th key={p.name} className="min-w-32 px-4 py-3 text-center text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">{p.name}</th>)}</tr></thead><tbody>{ids.map(id => <tr key={id} className="border-b last:border-0 hover:bg-muted/20"><td className="sticky left-0 bg-card px-5 py-4"><span className="flex items-center gap-2 font-mono text-xs font-bold"><Puzzle className="h-3.5 w-3.5 text-primary" />{id}</span></td>{data.profiles.map(p => { const key = `${id}:${p.name}`; return <td key={p.name} className="px-4 py-4 text-center"><Switch checked={p.has.includes(id)} disabled={busy === key} onCheckedChange={on => toggle(id, p.name, on)} aria-label={`${p.has.includes(id) ? 'Disable' : 'Enable'} ${id} for ${p.name}`} /></td> })}</tr>)}</tbody></table></div>

      <div className="space-y-3 md:hidden">{ids.map(id => <section key={id} className="surface-flat overflow-hidden"><div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-3 font-mono text-sm font-bold"><Puzzle className="h-4 w-4 text-primary" />{id}</div><div className="divide-y">{data.profiles.map(p => { const key = `${id}:${p.name}`; return <label key={p.name} className="flex items-center justify-between px-4 py-3 text-sm font-semibold"><span>{p.name}</span><Switch checked={p.has.includes(id)} disabled={busy === key} onCheckedChange={on => toggle(id, p.name, on)} /></label> })}</div></section>)}</div>
    </div>}
  </>
}
