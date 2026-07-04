import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

type Mcp = { servers: string[]; profiles: { name: string; has: string[] }[] }

export function McpPage() {
  const [data, setData] = useState<Mcp | null>(null)
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', command: 'npx', args: '' })
  const [from, setFrom] = useState('')
  const load = async () => { try { setData(await api.mcp()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])
  if (!data) return null

  const toggle = async (server: string, profile: string, on: boolean) => {
    try { on ? await api.addMcp({ name: server, targets: [profile] }) : await api.rmMcp(server, [profile]); await load() }
    catch (e: any) { toast.error(e.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">MCP servers</h1>
        <div className="flex gap-2 items-center">
          <select className="border rounded-md h-9 px-2 bg-background text-sm" value={from} onChange={e => setFrom(e.target.value)}>
            <option value="">sync from…</option>
            {data.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <Button variant="secondary" disabled={!from} onClick={async () => {
            try { await api.syncMcp(from, 'all'); toast.success(`Synced from ${from}`); await load() } catch (e: any) { toast.error(e.message) }
          }}>Sync → all</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add server</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add MCP server</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5"><Label>Name</Label><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="shadcn" /></div>
                <div className="space-y-1.5"><Label>Command</Label><Input value={f.command} onChange={e => setF({ ...f, command: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>Args (comma-separated)</Label><Input value={f.args} onChange={e => setF({ ...f, args: e.target.value })} placeholder="-y,@playwright/mcp@latest" /></div>
              </div>
              <DialogFooter><Button onClick={async () => {
                try { await api.addMcp({ name: f.name, command: f.command, args: f.args ? f.args.split(',') : [], targets: 'all' }); toast.success(`Added ${f.name}`); setOpen(false); setF({ name: '', command: 'npx', args: '' }); await load() }
                catch (e: any) { toast.error(e.message) }
              }}>Add to all</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="overflow-x-auto border rounded-lg">
        <table className="text-sm border-collapse w-full">
          <thead><tr className="border-b">
            <th className="text-left p-3 font-medium">Server</th>
            {data.profiles.map(p => <th key={p.name} className="p-3 text-center font-medium">{p.name}</th>)}
          </tr></thead>
          <tbody>
            {data.servers.map(s => (
              <tr key={s} className="border-b last:border-0">
                <td className="p-3 font-mono">{s}</td>
                {data.profiles.map(p => (
                  <td key={p.name} className="p-3 text-center">
                    <Switch checked={p.has.includes(s)} onCheckedChange={on => toggle(s, p.name, on)} />
                  </td>
                ))}
              </tr>
            ))}
            {data.servers.length === 0 && <tr><td className="p-3 text-muted-foreground" colSpan={data.profiles.length + 1}>No MCP servers yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
