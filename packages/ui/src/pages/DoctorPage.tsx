import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RotateCw, Stethoscope, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

export function DoctorPage() {
  const [problems, setProblems] = useState<string[] | null>(null)
  const [fixable, setFixable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fixing, setFixing] = useState(false)
  const load = async () => {
    setBusy(true)
    try { const r = await api.doctor(); setProblems(r.problems); setFixable(!!r.fixable) }
    catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }
  useEffect(() => { load() }, [])
  const fix = async () => {
    setFixing(true)
    try {
      const { fixed } = await api.fix()
      toast.success(fixed.length ? `Fixed ${fixed.length} finding(s)` : 'Nothing to fix')
      for (const f of fixed as string[]) toast.message(f)
      await load()
    } catch (e: any) { toast.error(e.message) } finally { setFixing(false) }
  }
  return (
    <>
      <PageHeader eyebrow="System health" title="Doctor" description="Check manifest integrity, linked files, launchers, secrets, plugin drift, and managed shell state." actions={<>
        <StatusPill tone={problems === null ? 'neutral' : problems.length ? 'warn' : 'good'}>{problems === null ? 'Checking' : problems.length ? `${problems.length} findings` : 'Healthy'}</StatusPill>
        {fixable && <Button onClick={fix} disabled={fixing || busy}><Wrench className={`h-4 w-4 ${fixing ? 'animate-spin' : ''}`} /> Fix what's fixable</Button>}
        <Button variant="outline" onClick={load} disabled={busy || fixing}><RotateCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Re-run</Button>
      </>} />
      {problems === null ? <LoadingState label="Running diagnostics" /> : problems.length === 0 ? <EmptyState icon={CheckCircle2} title="No problems found" description="All managed files and local configuration passed their checks." /> : (
        <div className="space-y-3">{problems.map((p, i) => <article key={i} className="surface-flat flex items-start gap-4 p-5"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning/10 text-warning"><AlertTriangle className="h-4 w-4" /></span><div><p className="eyebrow mb-1 text-warning">Finding {String(i + 1).padStart(2, '0')}</p><p className="text-sm leading-6">{p}</p></div></article>)}</div>
      )}
      <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground"><Stethoscope className="h-3.5 w-3.5" /> Diagnostics are read-only. "Fix what's fixable" clears only the safe, mechanical findings (plugin version drift, plaintext rc secrets).</div>
    </>
  )
}
