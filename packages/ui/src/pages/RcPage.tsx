import { useEffect, useState } from 'react'
import { FileCode2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type Rc = { rcFile: string; current: string | null; rendered: string; inSync: boolean }
function Block({ title, note, lines, otherLines, tint, sign }: { title: string; note: string; lines: string[]; otherLines: Set<string>; tint: string; sign: string }) {
  return <section className="min-w-0 flex-1 overflow-hidden rounded-xl border bg-[#242720] text-[#f5f0e5]"><div className="border-b border-white/10 px-4 py-3"><h2 className="text-sm font-bold">{title}</h2><p className="mt-0.5 text-[0.68rem] text-white/40">{note}</p></div><pre className="max-h-[520px] overflow-auto p-4 text-xs leading-6"><code>{lines.map((l, i) => { const diff = !otherLines.has(l) && l.trim() !== ''; return <span key={i} className={cn('block min-w-max rounded px-1', diff && tint)}><span className="inline-block w-3 select-none opacity-60">{diff ? sign : ''}</span>{l || ' '}{'\n'}</span> })}</code></pre></section>
}
export function RcPage() {
  const [rc, setRc] = useState<Rc | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const load = async () => { try { setRc(await api.rc()); setError(null) } catch (e: any) { setError(e.message); toast.error(e.message) } }
  useEffect(() => { load() }, [])
  if (error) return <><PageHeader eyebrow="Shell integration" title="Shell RC" description="Preview exactly what ccprofiles owns in your shell startup file." /><EmptyState icon={FileCode2} title="Manifest required" description="Adopt profiles from Status before generating the managed shell block." /></>
  if (!rc) return <><PageHeader eyebrow="Shell integration" title="Shell RC" description="Preview exactly what ccprofiles owns in your shell startup file." /><LoadingState label="Reading shell configuration" /></>
  const curLines = (rc.current ?? '').split('\n'); const newLines = rc.rendered.split('\n')
  return <><PageHeader eyebrow="Shell integration" title="Shell RC" description="Only content between ccprofiles markers is rewritten. Everything else stays untouched." actions={<><StatusPill tone={rc.inSync ? 'good' : 'warn'}>{rc.inSync ? 'In sync' : 'Update ready'}</StatusPill><Button disabled={rc.inSync || busy} onClick={async () => { setBusy(true); try { const r = await api.updateRc(); toast.success(r.backupDir ? `Updated — backup in ${r.backupDir}` : 'Updated'); load() } catch (e: any) { toast.error(e.message) } finally { setBusy(false) } }}>{busy ? 'Updating…' : `Update ${rc.rcFile.split('/').pop()}`}</Button></>} />
    <div className="mb-5 flex flex-col gap-3 rounded-xl border bg-muted/35 p-4 sm:flex-row sm:items-center"><ShieldCheck className="h-5 w-5 shrink-0 text-success" /><div className="min-w-0"><p className="text-sm font-semibold">Managed block only</p><p className="truncate font-mono text-xs text-muted-foreground">{rc.rcFile}</p></div><div className="ml-auto flex gap-3 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-red-400/50" />Removed</span><span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-emerald-400/50" />Added</span></div></div>
    <div className="grid gap-4 xl:grid-cols-2"><Block title="Currently in file" note="Managed block on disk" lines={rc.current === null ? ['(no managed block yet)'] : curLines} otherLines={new Set(newLines)} tint="bg-red-400/20" sign="−" /><Block title="From manifest" note="Block ccprofiles will write" lines={newLines} otherLines={new Set(curLines)} tint="bg-emerald-400/20" sign="+" /></div>
  </>
}
