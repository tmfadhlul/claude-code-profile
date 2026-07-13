import { useEffect, useState } from 'react'
import { ArrowDownToLine, KeyRound, Laptop, Link2, LoaderCircle, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { CommandBox, EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type Device = { name: string; host: string; port: number }
type Preview = { device: Device; performed: string[]; secrets: string[] }

/**
 * A single network round-trip has no real progress channel to report from, so this
 * doesn't claim to track actual server-side steps — it cycles through the stages a
 * request of this kind genuinely goes through client-side, at a pace close to how
 * long each tends to take, so "still working" reads as progress instead of a frozen
 * "Checking…" label for the whole wait.
 */
function useStagedLabel(active: boolean, stages: string[], stepMs = 1100): string {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!active) { setI(0); return }
    const id = setInterval(() => setI(n => Math.min(n + 1, stages.length - 1)), stepMs)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepMs])
  return stages[i]
}

function Spinner() { return <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> }

export function SyncPage() {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [withSecrets, setWithSecrets] = useState(false)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [applying, setApplying] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [pf, setPf] = useState({ host: '', port: '', pin: '', name: '' })
  const pairLabel = useStagedLabel(pairing, ['Connecting…', 'Verifying PIN…', 'Saving device…'])
  const pullLabel = useStagedLabel(previewing !== null, ['Connecting…', 'Fetching manifest…', 'Comparing…'])
  const applyLabel = useStagedLabel(applying, ['Writing configuration…', 'Reconciling plugins…', 'Almost done…'])
  const doPair = async () => {
    setPairing(true)
    try {
      const r = await api.pair({ host: pf.host.trim(), port: Number(pf.port), pin: pf.pin.trim(), name: pf.name.trim() || undefined })
      toast.success(`Paired with ${r.name} (${r.host}:${r.port})`)
      setPairOpen(false); setPf({ host: '', port: '', pin: '', name: '' })
      await load()
    } catch (e: any) { toast.error(e.message) } finally { setPairing(false) }
  }
  const pairDialog = <Dialog open={pairOpen} onOpenChange={o => { if (!pairing) setPairOpen(o) }}><DialogContent><DialogHeader><DialogTitle>Pair a device</DialogTitle><p className="text-sm leading-6 text-muted-foreground">On the other machine run <span className="font-mono text-foreground">clp serve</span> — it prints the port and a 6-digit PIN. Enter them here.</p></DialogHeader>
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
        <div><Label className="field-label">Host</Label><Input value={pf.host} onChange={e => setPf({ ...pf, host: e.target.value })} placeholder="192.168.1.10" autoFocus /></div>
        <div><Label className="field-label">Port</Label><Input className="font-mono" value={pf.port} onChange={e => setPf({ ...pf, port: e.target.value })} placeholder="51234" inputMode="numeric" /></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label className="field-label">PIN</Label><Input className="font-mono" value={pf.pin} onChange={e => setPf({ ...pf, pin: e.target.value })} placeholder="123456" inputMode="numeric" /></div>
        <div><Label className="field-label">Name <span className="normal-case tracking-normal">(optional)</span></Label><Input value={pf.name} onChange={e => setPf({ ...pf, name: e.target.value })} placeholder="mac" /></div>
      </div>
    </div>
    <DialogFooter><Button variant="outline" disabled={pairing} onClick={() => setPairOpen(false)}>Cancel</Button><Button disabled={pairing || !pf.host.trim() || !pf.port.trim() || !pf.pin.trim()} onClick={doPair}>{pairing && <Spinner />}{pairing ? pairLabel : 'Pair'}</Button></DialogFooter>
  </DialogContent></Dialog>
  const load = async () => { try { setDevices(await api.devices()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  // Preview first: dry-run the pull so the operator sees exactly what will change before
  // anything touches local state, then require a confirm to actually apply it.
  const startPull = async (d: Device) => {
    setPreviewing(d.name)
    try { const r = await api.sync(d.name, withSecrets, true); setPreview({ device: d, performed: r.performed, secrets: r.secrets }) }
    catch (e: any) { toast.error(e.message) }
    finally { setPreviewing(null) }
  }
  const confirmPull = async () => {
    if (!preview) return
    setApplying(true)
    try { const r = await api.sync(preview.device.name, withSecrets, false); toast.success(`Pulled ${r.performed.length} change(s)${r.secrets.length ? `, secrets: ${r.secrets.join(', ')}` : ''}`); setPreview(null) }
    catch (e: any) { toast.error(e.message) }
    finally { setApplying(false) }
  }

  return (
    <>
      <PageHeader eyebrow="Device network" title="Pull from a trusted device." description="Bring profile configuration to this machine. You choose when secrets cross the connection." actions={<>{devices && <StatusPill tone="info">{devices.length} paired</StatusPill>}<Button onClick={() => setPairOpen(true)}><Link2 className="h-4 w-4" /> Pair device</Button></>} />
      {!devices ? <LoadingState label="Finding paired devices" /> : devices.length === 0 ? <EmptyState icon={Radio} title="No paired devices" description="Run clp serve on the source machine, then pair it here (or from the CLI)." action={<div className="w-full max-w-lg space-y-3"><Button onClick={() => setPairOpen(true)}><Link2 className="h-4 w-4" /> Pair device</Button><CommandBox command="clp pair <host> --port <p> --pin <pin>" /></div>} /> : <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-3">{devices.map(d => <article key={d.name} className="surface-flat flex flex-col gap-4 p-5 sm:flex-row sm:items-center"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-muted"><Laptop className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 className="font-semibold">{d.name}</h2><p className="mt-1 font-mono text-xs text-muted-foreground">{d.host}:{d.port}</p></div><Button disabled={previewing !== null} onClick={() => startPull(d)}>{previewing === d.name ? <Spinner /> : <ArrowDownToLine className="h-4 w-4" />}{previewing === d.name ? pullLabel : 'Pull'}</Button></article>)}</section>
        <aside className="surface-flat h-fit p-6"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-primary" /> Include secrets</div><p className="mt-2 text-xs leading-5 text-muted-foreground">Pull encrypted secret values along with profile configuration.</p></div><Switch id="ws" checked={withSecrets} onCheckedChange={setWithSecrets} /></div><Label htmlFor="ws" className="mt-5 block cursor-pointer border-t pt-4 text-xs font-normal leading-5 text-muted-foreground">Off by default. Enable only when source device and current connection are trusted.</Label></aside>
      </div>}

      {pairDialog}
      {preview && <Dialog open onOpenChange={o => { if (!o && !applying) setPreview(null) }}><DialogContent><DialogHeader><DialogTitle>Pull from “{preview.device.name}”?</DialogTitle><p className="text-sm leading-6 text-muted-foreground">Review pending changes before they're applied to this machine.</p></DialogHeader>
        {preview.performed.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No changes — already in sync.</p> : <ul className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm">{preview.performed.map((p, i) => <li key={i} className="flex gap-3"><span className="mt-0.5 font-mono text-[0.65rem] text-primary">{String(i + 1).padStart(2, '0')}</span><span className="leading-5">{p}</span></li>)}</ul>}
        {preview.secrets.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Secrets to pull: <span className="font-mono">{preview.secrets.join(', ')}</span></p>}
        <DialogFooter><Button variant="outline" disabled={applying} onClick={() => setPreview(null)}>Cancel</Button><Button disabled={applying} onClick={confirmPull}>{applying && <Spinner />}{applying ? applyLabel : 'Pull changes'}</Button></DialogFooter>
      </DialogContent></Dialog>}
    </>
  )
}
