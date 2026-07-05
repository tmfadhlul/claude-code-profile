import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { ProfileEditor, type ProfileRow } from '@/components/ProfileEditor'

function providerHost(r: ProfileRow): string {
  const u = r.settingsEnv?.ANTHROPIC_BASE_URL
  if (!u) return '—'
  try { return new URL(u).host } catch { return u }
}

export function ProfilesPage() {
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [servers, setServers] = useState<string[]>([])
  const [secretNames, setSecretNames] = useState<string[]>([])
  const [name, setName] = useState(''); const [from, setFrom] = useState(''); const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ProfileRow | null>(null)
  const [deleting, setDeleting] = useState<ProfileRow | null>(null)

  const load = async () => {
    try { setRows(await api.profiles()) } catch (e: any) { toast.error(e.message) }
    try { setServers((await api.mcp()).servers) } catch { setServers([]) }         // 409 before adopt
    try { setSecretNames((await api.secrets()).names) } catch { setSecretNames([]) }
  }
  useEffect(() => { load() }, [])

  const doDelete = async (p: ProfileRow) => {
    try { await api.deleteProfile(p.name); toast.success(`Removed ${p.name} from manifest`); setDeleting(null); load() }
    catch (e: any) { toast.error(e.message) }
  }

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
          <TableHead>Name</TableHead><TableHead>Auth</TableHead><TableHead>Account</TableHead><TableHead>MCP</TableHead><TableHead>Launcher</TableHead><TableHead>Provider</TableHead><TableHead>Env</TableHead><TableHead className="w-32" />
        </TableRow></TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.name}>
              <TableCell className="font-medium">{r.name}{!r.adopted && <span className="text-muted-foreground" title="not in manifest — adopt to manage"> *</span>}</TableCell>
              <TableCell>{r.auth}</TableCell>
              <TableCell className="text-muted-foreground">{r.account ?? '—'}</TableCell>
              <TableCell>{r.mcp}</TableCell>
              <TableCell className="font-mono text-xs">{r.launcher ?? '—'}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{providerHost(r)}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{Object.keys(r.env).length || '—'}</TableCell>
              <TableCell>
                <div className="flex gap-1 justify-end">
                  <span title={r.adopted ? undefined : 'Adopt first'}>
                    <Button size="sm" variant="ghost" disabled={!r.adopted} onClick={() => setEditing(r)}>Edit</Button>
                  </span>
                  <span title={r.adopted ? undefined : 'Adopt first'}>
                    <Button size="sm" variant="ghost" disabled={!r.adopted} onClick={() => setDeleting(r)}>Delete</Button>
                  </span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editing && (
        <ProfileEditor profile={editing} servers={servers} secretNames={secretNames}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}

      {deleting && (
        <Dialog open onOpenChange={o => { if (!o) setDeleting(null) }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete profile "{deleting.name}"?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              Removes it from the manifest and drops its launcher from your shell rc on apply.
              The directory <span className="font-mono">{deleting.dir}</span> stays on disk — re-adopt to manage it again.
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => doDelete(deleting)}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
