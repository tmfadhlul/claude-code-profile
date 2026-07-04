import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

export function StatusPage() {
  const [state, setState] = useState<{ inSync: boolean; pending: string[] } | null>(null)
  const [needsAdopt, setNeedsAdopt] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setState(await api.status()); setNeedsAdopt(false) }
    catch (e: any) { if (String(e.message).includes('no manifest')) setNeedsAdopt(true); else toast.error(e.message) }
  }
  useEffect(() => { load() }, [])

  if (needsAdopt) return (
    <Card className="p-6 space-y-4 max-w-md">
      <div className="text-lg font-medium">No manifest yet</div>
      <p className="text-sm text-muted-foreground">Adopt your existing Claude profiles to get started.</p>
      <Button onClick={async () => { try { await api.adopt(); toast.success('Adopted your profiles'); load() } catch (e: any) { toast.error(e.message) } }}>
        Adopt profiles
      </Button>
    </Card>
  )

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Status</h1>
      {state?.inSync
        ? <Card className="p-6 text-green-500 font-medium">In sync ✓</Card>
        : <Card className="p-6 space-y-3">
            <div className="font-medium">Pending changes</div>
            <ul className="text-sm list-disc pl-5 space-y-1 text-muted-foreground">{state?.pending.map((p, i) => <li key={i}>{p}</li>)}</ul>
            <Button disabled={busy} onClick={async () => {
              setBusy(true)
              try { const r = await api.apply(); toast.success(`Applied ${r.performed.length} change(s)`); await load() }
              catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
            }}>Apply changes</Button>
          </Card>}
    </div>
  )
}
