import { useState, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  PROVIDER_PRESETS, detectPreset, applyPreset, emptyProviderForm, copyFromEnv, providerAuthMode,
  type ProviderForm as ProviderFormState, type TokenVar, type ProviderAuthMode,
} from '@/lib/provider'

export type CopySource = { name: string; env: Record<string, string> }

function Hint({ children }: { children: ReactNode }) {
  return <div className="mt-1 text-[0.62rem] text-muted-foreground font-mono">{children}</div>
}

const AUTH_MODES: { id: ProviderAuthMode; label: string }[] = [
  { id: 'login', label: 'CLI login' },
  { id: 'api-key', label: 'API key' },
  { id: 'auth-token', label: 'Auth token' },
]

/** Secret-backed (or plain) token value field, shared by the Anthropic and custom-provider layouts. */
function TokenField({ form, onChange, secretNames, showVarSelect }: {
  form: ProviderFormState; onChange: (f: ProviderFormState) => void; secretNames: string[]; showVarSelect?: boolean
}) {
  return (
    <div className="space-y-1">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        {form.token.secret ? (
          <select className="select-field" value={form.token.value}
            onChange={e => onChange({ ...form, token: { secret: true, value: e.target.value } })}>
            <option value="">— pick secret (token) —</option>
            {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        ) : (
          <Input className="flex-1 font-mono text-xs" type="password" value={form.token.value} placeholder="auth token"
            onChange={e => onChange({ ...form, token: { secret: false, value: e.target.value } })} />
        )}
        <label className="flex min-h-9 items-center gap-2 text-xs font-semibold text-muted-foreground whitespace-nowrap">
          <input type="checkbox" checked={form.token.secret}
            onChange={e => onChange({ ...form, token: { secret: e.target.checked, value: '' } })} />secret
        </label>
        {showVarSelect && (
          <select className="select-field text-xs sm:w-36" value={form.tokenVar}
            onChange={e => onChange({ ...form, tokenVar: e.target.value as TokenVar })}>
            <option value="ANTHROPIC_AUTH_TOKEN">AUTH_TOKEN</option>
            <option value="ANTHROPIC_API_KEY">API_KEY</option>
          </select>
        )}
      </div>
      <Hint>{form.tokenVar}</Hint>
    </div>
  )
}

export function ProviderForm({ form, onChange, secretNames, copySources, profileName }: {
  form: ProviderFormState; onChange: (f: ProviderFormState) => void
  secretNames: string[]; copySources: CopySource[]; profileName: string
}) {
  const [sel, setSel] = useState(() => detectPreset(form.baseUrl))
  const authMode = providerAuthMode(form)
  const setAuthMode = (mode: ProviderAuthMode) => {
    if (mode === 'login') { onChange({ ...form, token: { ...form.token, value: '' } }); return }
    onChange({ ...form, tokenVar: mode === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN' })
  }
  const launcher = profileName === 'default' ? 'claude' : `cl-${profileName}`

  const onSelect = (v: string) => {
    if (v.startsWith('copy:')) {
      const src = copySources.find(s => s.name === v.slice(5))
      if (src) { const f = copyFromEnv(src.env); setSel(detectPreset(f.baseUrl)); onChange(f) }
      return
    }
    setSel(v)
    if (v === 'anthropic') onChange(emptyProviderForm())
    else {
      const preset = PROVIDER_PRESETS.find(p => p.id === v)
      if (preset) onChange(applyPreset(form, preset))
    }
  }

  return (
    <div className="space-y-5">
      <div><label className="field-label">Provider preset</label><select className="select-field" value={sel} onChange={e => onSelect(e.target.value)}>
        <option value="anthropic">Anthropic (default)</option>
        {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        <option value="custom">Custom…</option>
        {copySources.length > 0 && <option disabled>── copy from ──</option>}
        {copySources.map(s => <option key={s.name} value={`copy:${s.name}`}>copy from {s.name}</option>)}
      </select></div>

      {sel === 'anthropic' ? (
        <div className="space-y-4 rounded-xl border bg-muted/20 p-4 sm:p-5">
          <div>
            <label className="field-label">Authentication</label>
            <div className="grid grid-cols-3 gap-1 rounded-lg border bg-card p-1" role="radiogroup" aria-label="Anthropic authentication mode">
              {AUTH_MODES.map(({ id, label }) => (
                <button key={id} type="button" role="radio" aria-checked={authMode === id} onClick={() => setAuthMode(id)}
                  className={cn(
                    'rounded-md px-2 py-2 text-xs font-bold transition-colors',
                    authMode === id ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {authMode === 'login' ? (
            <Hint>Run <span className="font-bold text-foreground">{launcher}</span> then <span className="font-bold text-foreground">/login</span> (or <span className="font-bold text-foreground">claude login</span>) to sign in.</Hint>
          ) : (
            <TokenField form={form} onChange={onChange} secretNames={secretNames} />
          )}
        </div>
      ) : (
        <div className="space-y-5 rounded-xl border bg-muted/20 p-4 sm:p-5">
          <div className="space-y-1">
            <Input className="font-mono text-xs" value={form.baseUrl} placeholder="https://provider.example.com/anthropic"
              onChange={e => onChange({ ...form, baseUrl: e.target.value })} />
            <Hint>ANTHROPIC_BASE_URL</Hint>
          </div>

          <TokenField form={form} onChange={onChange} secretNames={secretNames} showVarSelect={sel === 'custom'} />

          <div className="grid gap-3 sm:grid-cols-3">
            {(['opus', 'sonnet', 'haiku'] as const).map(slot => (
              <div key={slot} className="space-y-1">
                <Input className="font-mono text-xs" value={form.models[slot]} placeholder={`${slot} model`}
                  onChange={e => onChange({ ...form, models: { ...form.models, [slot]: e.target.value } })} />
                <Hint>ANTHROPIC_DEFAULT_{slot.toUpperCase()}_MODEL</Hint>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Input className="font-mono text-xs sm:w-48" value={form.timeoutMs} placeholder="timeout ms (optional)"
              onChange={e => onChange({ ...form, timeoutMs: e.target.value })} />
            <Hint>API_TIMEOUT_MS</Hint>
          </div>
        </div>
      )}
    </div>
  )
}
