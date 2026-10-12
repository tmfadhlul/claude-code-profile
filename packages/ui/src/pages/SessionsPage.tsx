import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, Clock, ChevronRight, History, MessageSquare, Search, UserRound, Wrench } from 'lucide-react'
import { toast } from '@/components/ui/sonner'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CommandBox, EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type SessionMeta = { id: string; mtime: number; lastActivity: number; messageCount: number; title?: string | null; firstPrompt: string | null; gitBranch: string | null; model: string | null; sizeBytes: number }
type ProjectSessions = { agent: 'claude' | 'codex'; scope: string; project: string; sessions: SessionMeta[] }
type TranscriptEntry = { id: string; role: 'user' | 'assistant' | 'tool'; text: string; label: string | null; timestamp: string | null }
type SessionTranscript = { id: string; agent: 'claude' | 'codex'; scope: string; project: string; messages: TranscriptEntry[] }
type SelectedSession = { agent: 'claude' | 'codex'; scope: string; project: string; session: SessionMeta; resume?: string }
type RecentSession = SelectedSession & { resume: string }

export function SessionsPage() {
  const [data, setData] = useState<ProjectSessions[] | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SelectedSession | null>(null)
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)

  useEffect(() => {
    api.sessions().then(setData).catch((e: any) => toast.error(e.message))
  }, [])
  useEffect(() => {
    if (!selected) { setTranscript(null); setTranscriptError(null); return }
    let active = true
    setTranscript(null); setTranscriptError(null)
    api.sessionTranscript(selected.agent, selected.scope, selected.session.id)
      .then((value: SessionTranscript) => { if (active) setTranscript(value) })
      .catch((e: any) => { if (active) setTranscriptError(e.message) })
    return () => { active = false }
  }, [selected])

  const filtered = useMemo(() => data?.filter(p => `${p.project} ${p.agent} ${p.scope} ${p.sessions.map(s => `${s.title ?? ''} ${s.firstPrompt ?? ''}`).join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? [], [data, query])

  return (
    <>
      <PageHeader eyebrow="Workspace history" title="Every session, by project." description="Browse Claude and Codex sessions shared across profiles for each project. Your most recent chats are on the Dashboard. Open any session to read its full conversation." actions={data && <StatusPill tone="info">{data.reduce((n, p) => n + p.sessions.length, 0)} sessions</StatusPill>} />
      {!data ? <LoadingState label="Indexing sessions" /> : data.length === 0 ? <EmptyState icon={History} title="No sessions found" description="Sessions appear here after Claude or Codex runs in a managed project." /> : (
        <div className="space-y-5">
          <div className="relative max-w-md"><Search className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-muted-foreground" /><Input className="pl-10" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search project or prompt…" aria-label="Search sessions" /></div>
          {filtered.length === 0 ? <EmptyState icon={Search} title="No matching sessions" description="Try a project name, agent, branch, or words from the opening prompt." /> : <div className="space-y-3">
            {filtered.map((p, i) => {
              const key = `${p.scope}:${p.project}:${i}`; const open = openKey === key
              return (
                <section key={key} className="surface-flat overflow-hidden">
                  <button onClick={() => setOpenKey(open ? null : key)} aria-expanded={open} className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/45 sm:p-5">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted"><History className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{p.project}</span><span className="mt-1 block text-xs text-muted-foreground">{p.scope} · {p.sessions.length} session{p.sessions.length === 1 ? '' : 's'}</span></span>
                    <StatusPill tone={p.agent === 'codex' ? 'info' : 'neutral'}>{p.agent}</StatusPill>
                    <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
                  </button>
                  {open && <div className="divide-y border-t bg-muted/15">{p.sessions.map(s => (
                    <article key={s.id} className="p-4 sm:p-5">
                      <button onClick={() => setSelected({ agent: p.agent, scope: p.scope, project: p.project, session: s })} className="group flex w-full items-start gap-3 rounded-lg text-left focus-visible:ring-offset-4">
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1"><span className="line-clamp-2 block text-sm font-semibold leading-5">{s.title ?? s.firstPrompt ?? <span className="font-normal text-muted-foreground">No opening prompt recorded</span>}</span><span className="mt-2 block text-xs leading-5 text-muted-foreground">{new Date(s.lastActivity).toLocaleString()} · {s.messageCount} messages{s.gitBranch ? ` · ${s.gitBranch}` : ''}{s.model ? ` · ${s.model}` : ''}</span></span>
                        <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-primary">Open chat <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
                      </button>
                      <div className="mt-4"><CommandBox command={p.agent === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`} label={`Copy resume command for ${s.id}`} /></div>
                    </article>
                  ))}</div>}
                </section>
              )
            })}
          </div>}
        </div>
      )}

      <TranscriptReader selected={selected} transcript={transcript} error={transcriptError} onClose={() => setSelected(null)} />
    </>
  )
}

/** The sessions you chatted in most recently, each with its resume command and transcript. */
export function RecentSessions() {
  const [recent, setRecent] = useState<RecentSession[] | null>(null)
  const [selected, setSelected] = useState<SelectedSession | null>(null)
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  useEffect(() => { api.recentSessions().then(setRecent).catch((e: any) => toast.error(e.message)) }, [])
  useEffect(() => {
    if (!selected) { setTranscript(null); setTranscriptError(null); return }
    let active = true
    setTranscript(null); setTranscriptError(null)
    api.sessionTranscript(selected.agent, selected.scope, selected.session.id)
      .then((value: SessionTranscript) => { if (active) setTranscript(value) })
      .catch((e: any) => { if (active) setTranscriptError(e.message) })
    return () => { active = false }
  }, [selected])
  if (!recent) return <LoadingState label="Finding recent chats" />
  if (!recent.length) return <EmptyState icon={History} title="No recent chats" description="Sessions appear here after Claude or Codex runs in a managed project." />
  return (
    <>
    <section className="surface-flat overflow-hidden">
      <h2 className="flex items-center gap-2 border-b p-4 text-sm font-semibold sm:px-5"><Clock className="h-4 w-4 text-primary" />Pick up where you left off <span className="font-normal text-muted-foreground">· {recent.length} most recently chatted</span></h2>
      <ol className="divide-y">{recent.map(r => (
        <li key={`${r.scope}:${r.agent}:${r.session.id}`} className="p-4 sm:p-5">
          <button onClick={() => setSelected(r)} className="group flex w-full items-start gap-3 rounded-lg text-left focus-visible:ring-offset-4">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1"><span className="line-clamp-2 block text-sm font-semibold leading-5">{r.session.title ?? r.session.firstPrompt ?? <span className="font-normal text-muted-foreground">No opening prompt recorded</span>}</span><span className="mt-1 block truncate text-xs leading-5 text-muted-foreground">{new Date(r.session.lastActivity).toLocaleString()} · {r.project} · {r.scope}{r.agent === 'codex' ? ' · codex' : ''}</span></span>
            <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-primary">Open chat <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
          </button>
          <div className="mt-3"><CommandBox command={r.resume} label={`Copy resume command for ${r.session.id}`} /></div>
        </li>
      ))}</ol>
    </section>
      <TranscriptReader selected={selected} transcript={transcript} error={transcriptError} onClose={() => setSelected(null)} />
    </>
  )
}

function TranscriptReader({ selected, transcript, error, onClose }: { selected: SelectedSession | null; transcript: SessionTranscript | null; error: string | null; onClose: () => void }) {
  const resume = selected?.resume ?? (selected ? (selected.agent === 'codex' ? `codex resume ${selected.session.id}` : `claude --resume ${selected.session.id}`) : '')
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!transcript) return
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [transcript])
  return (
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="bottom-0 left-auto right-0 top-0 flex h-auto max-h-none w-full max-w-3xl translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-r-0 p-0 sm:w-[min(760px,calc(100%-2rem))]">
        {selected && <>
          <DialogHeader className="shrink-0 border-b px-5 py-5 sm:px-7 sm:py-6">
            <div className="flex flex-wrap items-center gap-2"><StatusPill tone={selected.agent === 'codex' ? 'info' : 'neutral'}>{selected.agent}</StatusPill><StatusPill>{selected.scope}</StatusPill></div>
            <DialogTitle className="mt-2 line-clamp-2 pr-10 text-2xl sm:text-3xl">{selected.session.title ?? selected.session.firstPrompt ?? 'Session transcript'}</DialogTitle>
            <p className="truncate text-xs text-muted-foreground">{selected.project} · {new Date(selected.session.lastActivity).toLocaleString()}</p>
          </DialogHeader>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-muted/20 px-4 py-6 sm:px-7">
            {!transcript && !error ? <LoadingState label="Opening conversation" /> : error ? <EmptyState icon={MessageSquare} title="Could not open chat" description={error} /> : transcript?.messages.length === 0 ? <EmptyState icon={MessageSquare} title="No visible messages" description="Session contains metadata or internal events, but no user-facing conversation text." /> : (
              <div className="space-y-5">{groupTools(transcript?.messages ?? []).map(item => Array.isArray(item) ? <ToolGroup key={item[0].id} entries={item} /> : <TranscriptMessage key={item.id} message={item} />)}</div>
            )}
          </div>

          <div className="shrink-0 border-t bg-background p-4 sm:px-7"><CommandBox command={resume} label={`Copy resume command for ${selected.session.id}`} /></div>
        </>}
      </DialogContent>
    </Dialog>
  )
}

/** Consecutive tool calls and results collapse into one row, like Claude Code's "Used N tools". */
function groupTools(messages: TranscriptEntry[]): (TranscriptEntry | TranscriptEntry[])[] {
  const out: (TranscriptEntry | TranscriptEntry[])[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (m.role !== 'tool') out.push(m)
    else if (Array.isArray(last)) last.push(m)
    else out.push([m])
  }
  return out
}

const isResult = (e: TranscriptEntry) => e.label === 'Tool result'
// mcp__playwright__browser_click → playwright · browser_click
const toolName = (label: string | null) => (label ?? 'Tool call').replace(/^mcp__(.+?)__/, '$1 · ')

function ToolGroup({ entries }: { entries: TranscriptEntry[] }) {
  const calls = entries.filter(e => !isResult(e))
  const names = [...new Set(calls.map(e => toolName(e.label)))]
  const count = calls.length || entries.length
  return (
    <details className="group overflow-hidden rounded-xl border bg-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-bold text-muted-foreground marker:hidden">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="shrink-0">{calls.length ? `Used ${count} tool${count === 1 ? '' : 's'}` : `${count} tool result${count === 1 ? '' : 's'}`}</span>
        <span className="min-w-0 flex-1 truncate font-normal">{names.join(', ')}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="divide-y border-t">{entries.map(e => (
        <details key={e.id} className="group/tool">
          <summary className={cn('flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs marker:hidden', isResult(e) ? 'pl-9 text-muted-foreground' : 'font-semibold')}>
            <span className="min-w-0 flex-1 truncate">{isResult(e) ? '↳ result' : toolName(e.label)}</span>
            <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open/tool:rotate-180" />
          </summary>
          <pre className="max-h-80 overflow-auto bg-foreground p-4 text-[0.7rem] leading-5 text-background"><code className="whitespace-pre-wrap break-words">{e.text}</code></pre>
        </details>
      ))}</div>
    </details>
  )
}

function TranscriptMessage({ message }: { message: TranscriptEntry }) {
  const user = message.role === 'user'
  return (
    <article className={cn('flex items-start gap-3', user && 'flex-row-reverse')}>
      <span className={cn('mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full border', user ? 'border-primary/20 bg-primary/10 text-primary' : 'bg-card text-foreground')}>{user ? <UserRound className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}</span>
      <div className={cn('max-w-[88%]', user && 'text-right')}>
        <p className="mb-1.5 text-[0.62rem] font-bold uppercase tracking-wider text-muted-foreground">{user ? 'You' : 'Assistant'}{message.timestamp ? ` · ${new Date(message.timestamp).toLocaleTimeString()}` : ''}</p>
        <div className={cn('rounded-xl border px-4 py-3 text-left text-sm leading-6 shadow-sm', user ? 'border-primary/15 bg-primary text-primary-foreground' : 'bg-card')}><p className="whitespace-pre-wrap break-words">{message.text}</p></div>
      </div>
    </article>
  )
}
