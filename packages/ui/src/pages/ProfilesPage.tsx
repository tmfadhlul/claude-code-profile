import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

type Row = { name: string; dir: string; auth: string; account: string | null; mcp: number; launcher: string | null; adopted: boolean }

export function ProfilesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState(''); const [from, setFrom] = useState(''); const [open, setOpen] = useState(false)
  const load = async () => { try { setRows(await api.profiles()) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Profiles</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Create profile</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New profile</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="work" /></div>
              <div className="space-y-1.5">
                <Label>Copy MCP / links from (optional)</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={from} onChange={e => setFrom(e.target.value)}>
                  <option value="">— none —</option>
                  {rows.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={async () => {
                try { await api.createProfile(name, from || undefined); toast.success(`Created ${name}`); setOpen(false); setName(''); setFrom(''); load() }
                catch (e: any) { toast.error(e.message) }
              }}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Name</TableHead><TableHead>Auth</TableHead><TableHead>Account</TableHead><TableHead>MCP</TableHead><TableHead>Launcher</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.name}>
              <TableCell className="font-medium">{r.name}{!r.adopted && <span className="text-muted-foreground"> *</span>}</TableCell>
              <TableCell>{r.auth}</TableCell>
              <TableCell className="text-muted-foreground">{r.account ?? '—'}</TableCell>
              <TableCell>{r.mcp}</TableCell>
              <TableCell className="font-mono text-xs">{r.launcher ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
