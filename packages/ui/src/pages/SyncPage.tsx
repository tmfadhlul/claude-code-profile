import { useEffect, useState } from 'react'
import { ArrowDownToLine, KeyRound, Laptop, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { CommandBox, EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type Device = { name: string; host: string; port: number }
export function SyncPage() {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [withSecrets, setWithSecrets] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const load = async () => { try { setDevices(await api.devices()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  return (
    <>
      <PageHeader eyebrow="Device network" title="Pull from a trusted device." description="Bring profile configuration to this machine. You choose when secrets cross the connection." actions={devices && <StatusPill tone="info">{devices.length} paired</StatusPill>} />
      {!devices ? <LoadingState label="Finding paired devices" /> : devices.length === 0 ? <EmptyState icon={Radio} title="No paired devices" description="Pair a trusted machine from the CLI, then return here to pull its configuration." action={<div className="w-full max-w-lg"><CommandBox command="clp pair <host> --port <p> --pin <pin>" /></div>} /> : <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-3">{devices.map(d => <article key={d.name} className="surface-flat flex flex-col gap-4 p-5 sm:flex-row sm:items-center"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-muted"><Laptop className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 className="font-semibold">{d.name}</h2><p className="mt-1 font-mono text-xs text-muted-foreground">{d.host}:{d.port}</p></div><Button disabled={busy !== null} onClick={async () => { setBusy(d.name); try { const r = await api.sync(d.name, withSecrets); toast.success(`Pulled ${r.performed.length} change(s)${r.secrets.length ? `, secrets: ${r.secrets.join(', ')}` : ''}`) } catch (e: any) { toast.error(e.message) } finally { setBusy(null) } }}><ArrowDownToLine className="h-4 w-4" />{busy === d.name ? 'Pulling…' : 'Pull'}</Button></article>)}</section>
        <aside className="surface-flat h-fit p-6"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-primary" /> Include secrets</div><p className="mt-2 text-xs leading-5 text-muted-foreground">Pull encrypted secret values along with profile configuration.</p></div><Switch id="ws" checked={withSecrets} onCheckedChange={setWithSecrets} /></div><Label htmlFor="ws" className="mt-5 block cursor-pointer border-t pt-4 text-xs font-normal leading-5 text-muted-foreground">Off by default. Enable only when source device and current connection are trusted.</Label></aside>
      </div>}
    </>
  )
}
