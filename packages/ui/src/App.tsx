import { useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { StatusPage } from '@/pages/StatusPage'
import { ProfilesPage } from '@/pages/ProfilesPage'
import { McpPage } from '@/pages/McpPage'
import { PluginsPage } from '@/pages/PluginsPage'
import { SecretsPage } from '@/pages/SecretsPage'
import { RcPage } from '@/pages/RcPage'
import { SyncPage } from '@/pages/SyncPage'
import { DoctorPage } from '@/pages/DoctorPage'
import { SessionsPage } from '@/pages/SessionsPage'
import { cn } from '@/lib/utils'
import { Activity, Boxes, History, KeyRound, LayoutDashboard, Puzzle, RefreshCw, Stethoscope, Terminal, Users } from 'lucide-react'

const NAV = [
  { label: 'Overview', items: [['status', 'Status', LayoutDashboard]] },
  { label: 'Workspace', items: [['profiles', 'Profiles', Users], ['sessions', 'Sessions', History]] },
  { label: 'Configuration', items: [['mcp', 'MCP', Boxes], ['plugins', 'Plugins', Puzzle], ['secrets', 'Secrets', KeyRound], ['rc', 'Shell RC', Terminal]] },
  { label: 'System', items: [['sync', 'Sync', RefreshCw], ['doctor', 'Doctor', Stethoscope]] },
] as const

const TABS = NAV.flatMap((group) => group.items)
type Tab = typeof TABS[number][0]

export default function App() {
  const [tab, setTab] = useState<Tab>('status')

  function page() {
    if (tab === 'profiles') return <ProfilesPage />
    if (tab === 'sessions') return <SessionsPage />
    if (tab === 'mcp') return <McpPage />
    if (tab === 'plugins') return <PluginsPage />
    if (tab === 'secrets') return <SecretsPage />
    if (tab === 'rc') return <RcPage />
    if (tab === 'sync') return <SyncPage />
    if (tab === 'doctor') return <DoctorPage />
    return <StatusPage />
  }

  return (
    <div className="min-h-screen bg-background">
      <a href="#main-content" className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-card px-4 py-2 text-sm font-bold shadow-lg focus:translate-y-0">Skip to content</a>

      <aside className="relative z-20 bg-[#20231f] text-[#f5f0e5] lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-[244px] lg:flex-col lg:overflow-y-auto">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 lg:block lg:border-0 lg:px-6 lg:pb-10 lg:pt-7">
          <button onClick={() => setTab('status')} className="group flex items-center gap-3 rounded-lg text-left focus-visible:ring-[#d86b43] focus-visible:ring-offset-[#20231f]">
            <span className="grid h-9 w-9 place-items-center rounded-lg border border-white/15 bg-white/5 font-display text-xl text-[#e9784d]">cc</span>
            <span>
              <span className="block text-sm font-extrabold tracking-tight">ccprofiles</span>
              <span className="block text-[0.61rem] font-semibold uppercase tracking-[0.16em] text-white/45">Local control plane</span>
            </span>
          </button>
          <span className="inline-flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-[#95aa82] lg:hidden"><Activity className="h-3.5 w-3.5" /> Local</span>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 py-2 lg:block lg:flex-1 lg:space-y-6 lg:overflow-visible lg:px-4 lg:py-0" aria-label="Primary navigation">
          {NAV.map((group) => (
            <div key={group.label} className="contents lg:block">
              <p className="mb-2 hidden px-3 text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/35 lg:block">{group.label}</p>
              <div className="contents lg:block lg:space-y-1">
                {group.items.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    aria-current={tab === id ? 'page' : undefined}
                    className={cn(
                      'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:ring-[#d86b43] focus-visible:ring-offset-[#20231f] lg:w-full',
                      tab === id ? 'bg-[#f4eee1] text-[#242720]' : 'text-white/60 hover:bg-white/10 hover:text-white',
                    )}
                  >
                    <Icon className={cn('h-4 w-4', tab === id && 'text-[#c95732]')} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="mx-4 mb-5 mt-5 hidden rounded-xl border border-white/10 bg-white/[0.035] p-4 lg:block">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold text-[#a9bb99]"><span className="h-1.5 w-1.5 rounded-full bg-[#95aa82]" /> Local only</div>
          <p className="text-[0.69rem] leading-5 text-white/40">Credentials and profile state stay on this machine unless you explicitly sync.</p>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1} className="min-w-0 lg:ml-[244px] lg:min-h-screen">
        <div key={tab} className="page-shell page-enter">{page()}</div>
      </main>
      <Toaster position="bottom-right" />
    </div>
  )
}
