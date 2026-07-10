import { useEffect, useState } from 'react'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

type SessionMeta = {
  id: string; mtime: number; messageCount: number
  firstPrompt: string | null; gitBranch: string | null; model: string | null; sizeBytes: number
}
type ProjectSessions = { scope: string; project: string; sessions: SessionMeta[] }

export function SessionsPage() {
  const [data, setData] = useState<ProjectSessions[] | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  useEffect(() => { api.sessions().then(setData).catch((e: any) => toast.error(e.message)) }, [])
  if (!data) return null

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Sessions</h1>
      {data.length === 0 && <div className="text-sm text-muted-foreground">No sessions found.</div>}
      {data.map((p, i) => {
        const key = `${p.scope}:${p.project}:${i}`
        const open = openKey === key
        return (
          <div key={key} className="border rounded-lg">
            <button onClick={() => setOpenKey(open ? null : key)} className="w-full flex items-center justify-between gap-3 p-3 text-left">
              <span className="font-mono text-sm truncate">{p.project}</span>
              <span className="text-xs text-muted-foreground shrink-0">{p.scope} · {p.sessions.length} sessions</span>
            </button>
            {open && (
              <div className="border-t divide-y">
                {p.sessions.map(s => (
                  <div key={s.id} className="p-3 text-sm">
                    <div className="truncate">{s.firstPrompt ?? <span className="text-muted-foreground">(no prompt)</span>}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(s.mtime).toLocaleString()} · {s.messageCount} msg
                      {s.gitBranch ? ` · ${s.gitBranch}` : ''}{s.model ? ` · ${s.model}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
