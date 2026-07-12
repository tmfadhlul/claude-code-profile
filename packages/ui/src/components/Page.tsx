import type { ReactNode } from 'react'
import { Check, Clipboard, Inbox, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
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
    good: 'border-success/20 bg-success/10 text-success',
    warn: 'border-warning/20 bg-warning/10 text-warning',
    bad: 'border-destructive/20 bg-destructive/10 text-destructive',
    neutral: 'border-border bg-muted text-muted-foreground',
    info: 'border-info/20 bg-info/10 text-info',
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

// Shared destructive/high-impact confirmation dialog — reuse for anything that isn't
// safely reversible (matrix "sync to all", secret detach, enabling skip-permissions, ...).
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, destructive, onConfirm, busy }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode
  confirmLabel: string; destructive?: boolean; onConfirm: () => void; busy?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><p className="text-sm leading-6 text-muted-foreground">{description}</p></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CheckLine({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2 text-sm text-muted-foreground"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /><span>{children}</span></div>
}
