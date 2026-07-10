import type { ReactNode } from 'react'
import { Check, Clipboard, Inbox, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-5 border-b pb-7 sm:mb-10 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <p className="eyebrow mb-3">{eyebrow}</p>
        <h1 className="display-title">{title}</h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function LoadingState({ label = 'Loading workspace' }: { label?: string }) {
  return (
    <div className="surface-flat grid min-h-56 place-items-center p-8" role="status">
      <div className="text-center">
        <LoaderCircle className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" />
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">Reading local configuration…</p>
      </div>
    </div>
  )
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: { icon?: typeof Inbox; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="surface-flat grid min-h-64 place-items-center border-dashed p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border bg-muted/60"><Icon className="h-5 w-5 text-muted-foreground" /></div>
        <h2 className="font-display text-2xl font-medium">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  )
}

export function StatusPill({ tone = 'neutral', children, className }: { tone?: 'good' | 'warn' | 'bad' | 'neutral' | 'info'; children: ReactNode; className?: string }) {
  const tones = {
    good: 'border-emerald-700/20 bg-emerald-700/10 text-emerald-800',
    warn: 'border-amber-700/20 bg-amber-600/10 text-amber-800',
    bad: 'border-destructive/20 bg-destructive/10 text-destructive',
    neutral: 'border-border bg-muted text-muted-foreground',
    info: 'border-sky-700/20 bg-sky-700/10 text-sky-800',
  }
  return <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-[0.68rem] font-bold uppercase tracking-wider', tones[tone], className)}>{children}</span>
}

export function CommandBox({ command, label = 'Copy command' }: { command: string; label?: string }) {
  async function copy() {
    await navigator.clipboard.writeText(command)
    toast.success('Command copied')
  }
  return (
    <div className="command-box">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
      <Button variant="ghost" size="sm" className="h-8 shrink-0 text-background hover:bg-background/15 hover:text-background" onClick={copy} aria-label={label}>
        <Clipboard className="h-3.5 w-3.5" /> Copy
      </Button>
    </div>
  )
}

export function CheckLine({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2 text-sm text-muted-foreground"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" /><span>{children}</span></div>
}
