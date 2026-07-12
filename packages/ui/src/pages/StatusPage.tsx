import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, FolderKanban, History, KeyRound, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { CheckLine, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type State = { inSync: boolean; pending: string[] }
type Facts = { profiles: number; sessions: number; secrets: number }

export function StatusPage() {
  const [state, setState] = useState<State | null>(null)
  const [facts, setFacts] = useState<Facts>({ profiles: 0, sessions: 0, secrets: 0 })
  const [needsAdopt, setNeedsAdopt] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setState(await api.status()); setNeedsAdopt(false)
      const [profiles, sessions, secrets] = await Promise.allSettled([api.profiles(), api.sessions(), api.secrets()])
      setFacts({
        profiles: profiles.status === 'fulfilled' ? profiles.value.length : 0,
        sessions: sessions.status === 'fulfilled' ? sessions.value.reduce((n: number, p: any) => n + p.sessions.length, 0) : 0,
        secrets: secrets.status === 'fulfilled' ? secrets.value.names.length : 0,
      })
    } catch (e: any) {
      if (String(e.message).includes('no manifest')) setNeedsAdopt(true)
      else toast.error(e.message)
    }
  }
  useEffect(() => { load() }, [])

  if (needsAdopt) return (
    <>
      <PageHeader eyebrow="First run" title="Make this workspace yours." description="Bring existing Claude and Codex profiles under one local manifest. Files stay where they are." />
      <div className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
        <section className="surface relative overflow-hidden p-6 sm:p-9">
          <Sparkles className="mb-8 h-7 w-7 text-primary" />
          <h2 className="max-w-lg font-display text-3xl font-medium sm:text-4xl">Adopt what is already on this machine.</h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">ccprofiles discovers existing profile directories, creates a manifest, and leaves source folders intact.</p>
          <Button className="mt-7" size="lg" onClick={async () => {
            try { await api.adopt(); toast.success('Profiles adopted'); load() } catch (e: any) { toast.error(e.message) }
          }}>Adopt profiles <ArrowRight className="h-4 w-4" /></Button>
        </section>
        <aside className="surface-flat p-6 sm:p-7">
          <p className="eyebrow mb-5">What happens</p>
          <div className="space-y-4">
            <CheckLine>Find Claude and Codex profile folders.</CheckLine>
            <CheckLine>Create local manifest with launchers and links.</CheckLine>
            <CheckLine>Preview all managed changes before apply.</CheckLine>
          </div>
        </aside>
      </div>
    </>
  )

  if (!state) return <><PageHeader eyebrow="Overview" title="Workspace status" description="One view for local profile state and pending changes." /><LoadingState label="Checking workspace" /></>

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={state.inSync ? 'Everything is in its place.' : 'Changes are ready to apply.'}
        description={state.inSync ? 'Manifest, launchers, links, and managed shell block agree.' : 'Review pending work below, then apply it as one controlled update.'}
        actions={<StatusPill tone={state.inSync ? 'good' : 'warn'}>{state.inSync ? 'In sync' : `${state.pending.length} pending`}</StatusPill>}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)]">
        <section className="surface overflow-hidden">
          <div className="flex items-start gap-4 p-6 sm:p-8">
            <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${state.inSync ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
              {state.inSync ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-2xl font-medium">{state.inSync ? 'No intervention needed' : 'Pending operations'}</h2>
              {state.inSync ? (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">Keep working. Revisit after editing a profile or pulling another device.</p>
              ) : (
                <ul className="mt-4 divide-y border-y">
                  {state.pending.map((p, i) => <li key={i} className="flex gap-3 py-3 text-sm"><span className="mt-0.5 font-mono text-[0.65rem] text-primary">{String(i + 1).padStart(2, '0')}</span><span className="leading-5">{p}</span></li>)}
                </ul>
              )}
            </div>
          </div>
          {!state.inSync && <div className="flex justify-end border-t bg-muted/35 px-6 py-4 sm:px-8"><Button disabled={busy} onClick={async () => {
            setBusy(true)
            try { const r = await api.apply(); toast.success(`Applied ${r.performed.length} change(s)`); await load() }
            catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
          }}>{busy ? 'Applying…' : 'Apply changes'} <ArrowRight className="h-4 w-4" /></Button></div>}
        </section>

        <aside className="surface-flat p-6">
          <p className="eyebrow mb-5">At a glance</p>
          <div className="divide-y">
            <Fact icon={FolderKanban} label="Managed profiles" value={facts.profiles} />
            <Fact icon={History} label="Resumable sessions" value={facts.sessions} />
            <Fact icon={KeyRound} label="Stored secrets" value={facts.secrets} />
          </div>
        </aside>
      </div>
    </>
  )
}

function Fact({ icon: Icon, label, value }: { icon: typeof FolderKanban; label: string; value: number }) {
  return <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0"><Icon className="h-4 w-4 text-muted-foreground" /><span className="flex-1 text-sm text-muted-foreground">{label}</span><strong className="font-display text-2xl font-medium">{value}</strong></div>
}
