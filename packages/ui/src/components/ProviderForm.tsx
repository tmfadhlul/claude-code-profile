import { useState, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import {
  PROVIDER_PRESETS, detectPreset, applyPreset, emptyProviderForm, copyFromEnv,
  type ProviderForm as ProviderFormState, type TokenVar,
} from '@/lib/provider'

export type CopySource = { name: string; env: Record<string, string> }

function Hint({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-muted-foreground font-mono">{children}</div>
}

export function ProviderForm({ form, onChange, secretNames, copySources }: {
  form: ProviderFormState; onChange: (f: ProviderFormState) => void
  secretNames: string[]; copySources: CopySource[]
}) {
  const [sel, setSel] = useState(() => detectPreset(form.baseUrl))

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
    <div className="space-y-3">
      <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={sel} onChange={e => onSelect(e.target.value)}>
        <option value="anthropic">Anthropic (default)</option>
        {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        <option value="custom">Custom…</option>
        {copySources.length > 0 && <option disabled>── copy from ──</option>}
        {copySources.map(s => <option key={s.name} value={`copy:${s.name}`}>copy from {s.name}</option>)}
      </select>

      {sel === 'anthropic' ? (
        <p className="text-xs text-muted-foreground">Uses Anthropic's API with this profile's normal auth — no provider overrides.</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <Input className="font-mono text-xs" value={form.baseUrl} placeholder="https://provider.example.com/anthropic"
              onChange={e => onChange({ ...form, baseUrl: e.target.value })} />
            <Hint>ANTHROPIC_BASE_URL</Hint>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {form.token.secret ? (
                <select className="flex-1 border rounded-md h-9 px-2 bg-background text-sm" value={form.token.value}
                  onChange={e => onChange({ ...form, token: { secret: true, value: e.target.value } })}>
                  <option value="">— pick secret (token) —</option>
                  {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              ) : (
                <Input className="flex-1 font-mono text-xs" type="password" value={form.token.value} placeholder="auth token"
                  onChange={e => onChange({ ...form, token: { secret: false, value: e.target.value } })} />
              )}
              <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                <input type="checkbox" checked={form.token.secret}
                  onChange={e => onChange({ ...form, token: { secret: e.target.checked, value: '' } })} />secret
              </label>
              {sel === 'custom' && (
                <select className="border rounded-md h-9 px-2 bg-background text-xs" value={form.tokenVar}
                  onChange={e => onChange({ ...form, tokenVar: e.target.value as TokenVar })}>
                  <option value="ANTHROPIC_AUTH_TOKEN">AUTH_TOKEN</option>
                  <option value="ANTHROPIC_API_KEY">API_KEY</option>
                </select>
              )}
            </div>
            <Hint>{form.tokenVar}</Hint>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(['opus', 'sonnet', 'haiku'] as const).map(slot => (
              <div key={slot} className="space-y-1">
                <Input className="font-mono text-xs" value={form.models[slot]} placeholder={`${slot} model`}
                  onChange={e => onChange({ ...form, models: { ...form.models, [slot]: e.target.value } })} />
                <Hint>ANTHROPIC_DEFAULT_{slot.toUpperCase()}_MODEL</Hint>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Input className="font-mono text-xs w-40" value={form.timeoutMs} placeholder="timeout ms (optional)"
              onChange={e => onChange({ ...form, timeoutMs: e.target.value })} />
            <Hint>API_TIMEOUT_MS</Hint>
          </div>
        </div>
      )}
    </div>
  )
}
