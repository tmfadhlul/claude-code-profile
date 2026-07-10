import { useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { StatusPage } from '@/pages/StatusPage'
import { ProfilesPage } from '@/pages/ProfilesPage'
import { McpPage } from '@/pages/McpPage'
import { SecretsPage } from '@/pages/SecretsPage'
import { RcPage } from '@/pages/RcPage'
import { SyncPage } from '@/pages/SyncPage'
import { DoctorPage } from '@/pages/DoctorPage'
import { SessionsPage } from '@/pages/SessionsPage'
import { cn } from '@/lib/utils'
import { LayoutDashboard, Users, Boxes, KeyRound, RefreshCw, Stethoscope, Terminal, History } from 'lucide-react'

const TABS = [
  ['status', 'Status', LayoutDashboard],
  ['profiles', 'Profiles', Users],
  ['sessions', 'Sessions', History],
  ['mcp', 'MCP', Boxes],
  ['secrets', 'Secrets', KeyRound],
  ['rc', 'Shell RC', Terminal],
  ['sync', 'Sync', RefreshCw],
  ['doctor', 'Doctor', Stethoscope],
] as const
type Tab = typeof TABS[number][0]

export default function App() {
  const [tab, setTab] = useState<Tab>('status')
  return (
    <div className="flex h-screen">
      <aside className="w-52 border-r p-3 space-y-1 shrink-0">
        <div className="px-2 pb-4 pt-1 text-lg font-semibold tracking-tight">ccprofiles</div>
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id as Tab)}
            className={cn(
              'w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-md text-sm transition-colors',
              tab === id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </aside>
      <main className="flex-1 overflow-auto p-8">
        {tab === 'status' && <StatusPage />}
        {tab === 'profiles' && <ProfilesPage />}
        {tab === 'sessions' && <SessionsPage />}
        {tab === 'mcp' && <McpPage />}
        {tab === 'secrets' && <SecretsPage />}
        {tab === 'rc' && <RcPage />}
        {tab === 'sync' && <SyncPage />}
        {tab === 'doctor' && <DoctorPage />}
      </main>
      <Toaster />
    </div>
  )
}
