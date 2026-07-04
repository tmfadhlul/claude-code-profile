import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

type Device = { name: string; host: string; port: number }

export function SyncPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [withSecrets, setWithSecrets] = useState(false)
  const load = async () => { try { setDevices(await api.devices()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sync</h1>
        <div className="flex items-center gap-2"><Switch id="ws" checked={withSecrets} onCheckedChange={setWithSecrets} /><Label htmlFor="ws">with secrets</Label></div>
      </div>
      {devices.length === 0
        ? <Card className="p-6 text-sm text-muted-foreground">No paired devices. Pair one from the CLI: <code className="font-mono text-foreground">clp pair &lt;host&gt; --port &lt;p&gt; --pin &lt;pin&gt;</code></Card>
        : devices.map(d => (
          <Card key={d.name} className="p-4 flex items-center justify-between">
            <div><div className="font-medium">{d.name}</div><div className="text-xs text-muted-foreground">{d.host}:{d.port}</div></div>
            <Button onClick={async () => {
              try { const r = await api.sync(d.name, withSecrets); toast.success(`Pulled ${r.performed.length} change(s)${r.secrets.length ? `, secrets: ${r.secrets.join(', ')}` : ''}`) }
              catch (e: any) { toast.error(e.message) }
            }}>Pull</Button>
          </Card>
        ))}
    </div>
  )
}
