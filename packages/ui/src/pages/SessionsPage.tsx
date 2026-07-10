import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, History, MessageSquare, Search } from 'lucide-react'
import { toast } from '@/components/ui/sonner'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CommandBox, EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

type SessionMeta = { id: string; mtime: number; messageCount: number; firstPrompt: string | null; gitBranch: string | null; model: string | null; sizeBytes: number }
type ProjectSessions = { agent: 'claude' | 'codex'; scope: string; project: string; sessions: SessionMeta[] }

export function SessionsPage() {
  const [data, setData] = useState<ProjectSessions[] | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => { api.sessions().then(setData).catch((e: any) => toast.error(e.message)) }, [])
  const filtered = useMemo(() => data?.filter(p => `${p.project} ${p.agent} ${p.scope} ${p.sessions.map(s => s.firstPrompt).join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? [], [data, query])

  return (
    <>
      <PageHeader eyebrow="Workspace history" title="Resume where you left off." description="Browse Claude and Codex sessions shared across profiles for each project." actions={data && <StatusPill tone="info">{data.reduce((n, p) => n + p.sessions.length, 0)} sessions</StatusPill>} />
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
                      <div className="flex items-start gap-3"><MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="line-clamp-2 text-sm font-semibold leading-5">{s.firstPrompt ?? <span className="font-normal text-muted-foreground">No opening prompt recorded</span>}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{new Date(s.mtime).toLocaleString()} · {s.messageCount} messages{s.gitBranch ? ` · ${s.gitBranch}` : ''}{s.model ? ` · ${s.model}` : ''}</p></div></div>
                      <div className="mt-4"><CommandBox command={p.agent === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`} label={`Copy resume command for ${s.id}`} /></div>
                    </article>
                  ))}</div>}
                </section>
              )
            })}
          </div>}
        </div>
      )}
    </>
  )
}
