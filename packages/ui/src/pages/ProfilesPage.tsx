import { useEffect, useMemo, useState } from 'react'
import { Bot, Box, ChevronRight, Code2, History, Plus, Search, ShieldAlert, Terminal, Trash2, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProfileEditor, type ProfileRow } from '@/components/ProfileEditor'
import { EmptyState, LoadingState, PageHeader, StatusPill } from '@/components/Page'

function providerHost(r: ProfileRow): string {
  const u = r.settingsEnv?.ANTHROPIC_BASE_URL
  if (!u) return 'Default provider'
  try { return new URL(u).host } catch { return u }
}

export function ProfilesPage() {
  const [rows, setRows] = useState<ProfileRow[] | null>(null)
  const [servers, setServers] = useState<string[]>([]); const [secretNames, setSecretNames] = useState<string[]>([])
  const [name, setName] = useState(''); const [from, setFrom] = useState(''); const [open, setOpen] = useState(false)
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude'); const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ProfileRow | null>(null); const [deleting, setDeleting] = useState<ProfileRow | null>(null)
  const load = async () => {
    const [rowsR, mcpR, secretsR] = await Promise.allSettled([api.profiles(), api.mcp(), api.secrets()])
    if (rowsR.status === 'fulfilled') setRows(rowsR.value)
    else { toast.error(rowsR.reason?.message ?? String(rowsR.reason)); setRows([]) }
    setServers(mcpR.status === 'fulfilled' ? mcpR.value.servers : [])
    setSecretNames(secretsR.status === 'fulfilled' ? secretsR.value.names : [])
  }
  useEffect(() => { load() }, [])
  const filtered = useMemo(() => rows?.filter(r => `${r.name} ${r.agent} ${r.account ?? ''} ${providerHost(r)}`.toLowerCase().includes(query.toLowerCase())) ?? [], [rows, query])
  const doDelete = async (p: ProfileRow) => { try { await api.deleteProfile(p.name); toast.success(`Removed ${p.name} from manifest`); setDeleting(null); load() } catch (e: any) { toast.error(e.message) } }

  const createDialog = <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> Create profile</Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>New profile</DialogTitle><p className="text-sm leading-6 text-muted-foreground">Create an isolated agent identity. Copy connections from an existing profile if useful.</p></DialogHeader>
      <div className="space-y-5">
        <div><Label className="field-label">Agent</Label><div className="grid grid-cols-2 gap-2">
          {(['claude', 'codex'] as const).map(a => <button key={a} type="button" onClick={() => setAgent(a)} className={cn('rounded-xl border p-4 text-left transition-colors', agent === a ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'bg-card hover:bg-muted/50')}><span className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-muted">{a === 'claude' ? <Bot className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}</span><span className="block text-sm font-bold">{a === 'claude' ? 'Claude Code' : 'Codex'}</span><span className="mt-1 block text-[0.68rem] text-muted-foreground">{a === 'claude' ? 'Anthropic runtime' : 'OpenAI runtime'}</span></button>)}
        </div></div>
        <div><Label className="field-label" htmlFor="profile-name">Profile name</Label><Input id="profile-name" value={name} onChange={e => setName(e.target.value)} placeholder="work" autoFocus /></div>
        <div><Label className="field-label" htmlFor="profile-source">Copy setup from <span className="normal-case tracking-normal">(optional)</span></Label><select id="profile-source" className="select-field" value={from} onChange={e => setFrom(e.target.value)}><option value="">Start clean</option>{rows?.filter(r => r.agent === agent).map(r => <option key={r.name} value={r.name}>{r.name}</option>)}</select><p className="mt-1.5 text-xs text-muted-foreground">Copies MCP servers and managed links.</p></div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim()} onClick={async () => { try { await api.createProfile(name.trim(), agent, from || undefined); toast.success(`Created ${name.trim()}`); setOpen(false); setName(''); setFrom(''); load() } catch (e: any) { toast.error(e.message) } }}>Create profile</Button></DialogFooter>
    </DialogContent>
  </Dialog>

  return <>
    <PageHeader eyebrow="Agent identities" title="Profiles" description="Keep accounts, providers, tools, launchers, and session history separate—or share only what you choose." actions={createDialog} />
    {!rows ? <LoadingState label="Loading profiles" /> : rows.length === 0 ? <EmptyState icon={UserRound} title="No managed profiles" description="Create a Claude Code or Codex identity to start managing local configuration." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Create profile</Button>} /> : <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative w-full max-w-md"><Search className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-muted-foreground" /><Input className="pl-10" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search profiles…" aria-label="Search profiles" /></div><p className="text-xs text-muted-foreground">{filtered.length} of {rows.length} profiles</p></div>
      {filtered.length === 0 ? <EmptyState icon={Search} title="No matching profiles" description="Try another name, account, provider, or agent." /> : <div className="surface-flat overflow-hidden divide-y">{filtered.map(r => <article key={r.name} className="group relative p-5 transition-colors hover:bg-muted/30 sm:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center">
          <button className="flex min-w-0 flex-1 items-start gap-4 text-left" disabled={!r.adopted} onClick={() => setEditing(r)}>
            <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl border', r.agent === 'codex' ? 'bg-sky-700/5 text-sky-800' : 'bg-primary/5 text-primary')}>{r.agent === 'codex' ? <Code2 className="h-5 w-5" /> : <Bot className="h-5 w-5" />}</span>
            <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><strong className="text-base">{r.name}</strong><StatusPill tone={r.adopted ? 'good' : 'warn'}>{r.adopted ? 'Managed' : 'Discovered'}</StatusPill>{r.sharedSessions && <StatusPill tone="info">Shared sessions</StatusPill>}{r.skipPermissions && <StatusPill tone="bad">Skip prompts</StatusPill>}</span><span className="mt-2 block truncate text-sm text-muted-foreground">{r.account ?? 'No account label'} · {r.auth}</span></span>
          </button>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-4 xl:w-[540px] xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
            <MiniFact icon={Terminal} label="Launcher" value={r.launcher ?? 'None'} mono />
            <MiniFact icon={Box} label="MCP servers" value={String(r.mcp)} />
            <MiniFact icon={History} label="Session pool" value={r.sharedSessions ? 'Shared' : 'Private'} />
            <MiniFact icon={ShieldAlert} label="Provider" value={r.agent === 'claude' ? providerHost(r) : 'OpenAI'} />
          </div>
          <div className="flex shrink-0 justify-end gap-1 xl:pl-2"><span title={r.adopted ? undefined : 'Adopt profile first'}><Button size="sm" variant="ghost" disabled={!r.adopted} onClick={() => setEditing(r)}>Configure <ChevronRight className="h-4 w-4" /></Button></span><span title={r.adopted ? undefined : 'Adopt profile first'}><Button size="icon" variant="ghost" className="h-9 w-9 text-muted-foreground hover:text-destructive" disabled={!r.adopted} onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" /></Button></span></div>
        </div>
      </article>)}</div>}
    </div>}

    {editing && rows && <ProfileEditor profile={editing} profiles={rows} servers={servers} secretNames={secretNames} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    {deleting && <Dialog open onOpenChange={o => { if (!o) setDeleting(null) }}><DialogContent><DialogHeader><DialogTitle>Remove “{deleting.name}”?</DialogTitle><p className="text-sm leading-6 text-muted-foreground">Manifest entry and launcher are removed on next apply. Profile directory remains on disk and can be adopted again.</p></DialogHeader><div className="rounded-lg border bg-muted/35 p-3 font-mono text-xs text-muted-foreground break-all">{deleting.dir}</div><DialogFooter><Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" onClick={() => doDelete(deleting)}>Remove profile</Button></DialogFooter></DialogContent></Dialog>}
  </>
}

function MiniFact({ icon: Icon, label, value, mono }: { icon: typeof Terminal; label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><span className="flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-wider text-muted-foreground"><Icon className="h-3 w-3" />{label}</span><span className={cn('mt-1 block truncate text-xs font-semibold', mono && 'font-mono')}>{value}</span></div>
}
