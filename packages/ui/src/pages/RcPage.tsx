import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Rc = { rcFile: string; current: string | null; rendered: string; inSync: boolean }

function Block({ title, lines, otherLines, tint }: { title: string; lines: string[]; otherLines: Set<string>; tint: string }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium mb-1.5">{title}</div>
      <pre className="border rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre">
        {lines.map((l, i) => (
          <div key={i} className={cn('px-1 -mx-1 rounded-sm', !otherLines.has(l) && l.trim() !== '' && tint)}>{l || ' '}</div>
        ))}
      </pre>
    </div>
  )
}

export function RcPage() {
  const [rc, setRc] = useState<Rc | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setRc(await api.rc()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  if (!rc) return <div className="text-sm text-muted-foreground">Loading…</div>

  const curLines = (rc.current ?? '').split('\n')
  const newLines = rc.rendered.split('\n')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          Shell RC
          <Badge variant={rc.inSync ? 'secondary' : 'default'}>{rc.inSync ? 'in sync' : 'out of sync'}</Badge>
        </h1>
        <Button disabled={rc.inSync || busy} onClick={async () => {
          setBusy(true)
          try {
            const r = await api.updateRc()
            toast.success(r.backupDir ? `Updated — backup in ${r.backupDir}` : 'Updated')
            load()
          } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
        }}>Update {rc.rcFile.split('/').pop()}</Button>
      </div>
      <div className="text-sm text-muted-foreground font-mono">{rc.rcFile}</div>
      <p className="text-sm text-muted-foreground">
        Only the managed block (between the ccprofiles markers) is ever rewritten. Everything else in the file is untouched.
      </p>
      <div className="flex gap-4">
        <Block title="Currently in file" lines={rc.current === null ? ['(no managed block yet)'] : curLines}
          otherLines={new Set(newLines)} tint="bg-red-500/10" />
        <Block title="From manifest" lines={newLines} otherLines={new Set(curLines)} tint="bg-green-500/10" />
      </div>
    </div>
  )
}
