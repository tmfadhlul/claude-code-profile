import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, FolderKanban, History, KeyRound, Sparkles, Stethoscope, Users, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { CheckLine, LoadingState, PageHeader, StatusPill } from '@/components/Page'
import { RecentSessions } from '@/pages/SessionsPage'

type State = { inSync: boolean; pending: string[] }
type Facts = { profiles: number; sessions: number; secrets: number }
type Health = { problems: string[]; fixable: boolean }
type Profile = { name: string; agent: 'claude' | 'codex'; auth: string; account: string | null; launcher: string | null; adopted: boolean; sharedSessions: boolean; fallback: string | null }

export function StatusPage() {
  const [state, setState] = useState<State | null>(null)
  const [facts, setFacts] = useState<Facts>({ profiles: 0, sessions: 0, secrets: 0 })
  const [health, setHealth] = useState<Health | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [needsAdopt, setNeedsAdopt] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setState(await api.status()); setNeedsAdopt(false)
      const [profiles, sessions, secrets, doctor] = await Promise.allSettled([api.profiles(), api.sessions(), api.secrets(), api.doctor()])
      setProfiles(profiles.status === 'fulfilled' ? profiles.value : [])
      setHealth(doctor.status === 'fulfilled' ? doctor.value : null)
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

  if (!state) return <><PageHeader eyebrow="Overview" title="Dashboard" description="Workspace state, health, and the chats you were last in." /><LoadingState label="Checking workspace" /></>

  const problems = health?.problems.length ?? 0
  const attention = state.pending.length + problems

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title={!health ? 'Dashboard' : attention === 0 ? 'Everything is in its place.' : `${attention} thing${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention.`}
        description="Sync state, health checks, profiles, and the chats you were last in — in one view."
        actions={<div className="flex flex-wrap gap-2">
          <StatusPill tone={state.inSync ? 'good' : 'warn'}>{state.inSync ? 'In sync' : `${state.pending.length} pending`}</StatusPill>
          {health && <StatusPill tone={problems ? 'bad' : 'good'}>{problems ? `${problems} issue${problems === 1 ? '' : 's'}` : 'Healthy'}</StatusPill>}
        </div>}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)]">
        <div className="min-w-0 space-y-5">
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

        {health && <section className="surface-flat overflow-hidden">
          <div className="flex items-start gap-4 p-6 sm:p-8">
            <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${problems ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'}`}><Stethoscope className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-2xl font-medium">{problems ? 'Health issues' : 'Health checks pass'}</h2>
              {problems ? (
                <ul className="mt-4 divide-y border-y">{health.problems.map((p, i) => <li key={i} className="break-words py-3 text-sm leading-5">{p}</li>)}</ul>
              ) : <p className="mt-2 text-sm leading-6 text-muted-foreground">No broken links, plaintext secrets, plugin drift, or missing profiles.</p>}
            </div>
          </div>
          {problems > 0 && <div className="flex justify-end gap-2 border-t bg-muted/35 px-6 py-4 sm:px-8">
            <Button variant="outline" onClick={() => { location.hash = 'doctor' }}>Open doctor</Button>
            {health.fixable && <Button disabled={busy} onClick={async () => {
              setBusy(true)
              try { await api.fix(); toast.success('Fixes applied'); await load() }
              catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
            }}><Wrench className="h-4 w-4" /> Fix automatically</Button>}
          </div>}
        </section>}

        <RecentSessions />
        </div>

        <aside className="surface-flat p-6">
          <p className="eyebrow mb-5">At a glance</p>
          <div className="divide-y">
            <Fact icon={FolderKanban} label="Managed profiles" value={facts.profiles} />
            <Fact icon={History} label="Resumable sessions" value={facts.sessions} />
            <Fact icon={KeyRound} label="Stored secrets" value={facts.secrets} />
          </div>
          {profiles.length > 0 && <>
            <p className="eyebrow mb-4 mt-8 flex items-center gap-2"><Users className="h-3.5 w-3.5" />Profiles</p>
            <ul className="divide-y">{profiles.map(p => (
              <li key={`${p.agent}:${p.name}`} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>{p.agent === 'codex' && <StatusPill tone="info">codex</StatusPill>}{!p.adopted && <StatusPill tone="warn">not adopted</StatusPill>}</div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{[p.account ?? p.auth, p.launcher && `$ ${p.launcher}`, p.sharedSessions && 'shared sessions', p.fallback && `falls back to ${p.fallback}`].filter(Boolean).join(' · ')}</p>
              </li>
            ))}</ul>
          </>}
        </aside>
      </div>
    </>
  )
}

function Fact({ icon: Icon, label, value }: { icon: typeof FolderKanban; label: string; value: number }) {
  return <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0"><Icon className="h-4 w-4 text-muted-foreground" /><span className="flex-1 text-sm text-muted-foreground">{label}</span><strong className="font-display text-2xl font-medium">{value}</strong></div>
}
