import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RotateCw, Stethoscope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

export function DoctorPage() {
  const [problems, setProblems] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => { setBusy(true); try { setProblems((await api.doctor()).problems) } catch (e: any) { toast.error(e.message) } finally { setBusy(false) } }
  useEffect(() => { load() }, [])
  return (
    <>
      <PageHeader eyebrow="System health" title="Doctor" description="Check manifest integrity, linked files, launchers, secrets, and managed shell state." actions={<><StatusPill tone={problems === null ? 'neutral' : problems.length ? 'warn' : 'good'}>{problems === null ? 'Checking' : problems.length ? `${problems.length} findings` : 'Healthy'}</StatusPill><Button variant="outline" onClick={load} disabled={busy}><RotateCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Re-run</Button></>} />
      {problems === null ? <LoadingState label="Running diagnostics" /> : problems.length === 0 ? <EmptyState icon={CheckCircle2} title="No problems found" description="All managed files and local configuration passed their checks." /> : (
        <div className="space-y-3">{problems.map((p, i) => <article key={i} className="surface-flat flex items-start gap-4 p-5"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-600/10 text-amber-800"><AlertTriangle className="h-4 w-4" /></span><div><p className="eyebrow mb-1 text-amber-800">Finding {String(i + 1).padStart(2, '0')}</p><p className="text-sm leading-6">{p}</p></div></article>)}</div>
      )}
      <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground"><Stethoscope className="h-3.5 w-3.5" /> Read-only diagnostics. Doctor never changes files.</div>
    </>
  )
}
