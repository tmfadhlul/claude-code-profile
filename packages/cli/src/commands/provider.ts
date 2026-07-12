import type { Command } from 'commander'
import { anthropicAuthMode, setAnthropicAuthMode, executeApply, saveManifest, type AnthropicAuthMode } from 'ccprofiles-core'
import { requireManifest, type CliContext } from '../context.js'
import { planActions } from '../plan.js'
import { secretsStore, readSecretMasked } from './secrets.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

export function registerProviderCommands(program: Command, ctx: CliContext): void {
  const provider = program.command('provider').description('manage a profile’s LLM provider auth')

  provider.command('list').description('show each Claude profile’s Anthropic auth mode').action(async () => {
    const m = await requireManifest(ctx)
    for (const p of m.profiles) {
      if ((p.agent ?? 'claude') !== 'claude') continue
      console.log(`${p.name.padEnd(16)} ${anthropicAuthMode(p.settingsEnv)}`)
    }
  })

  provider.command('anthropic <profile>')
    .description('set the Anthropic auth mode for a Claude profile')
    .option('--login', 'use interactive CLI login (clears any stored token)')
    .option('--api-key', 'authenticate with an Anthropic API key')
    .option('--auth-token', 'authenticate with an Anthropic auth token')
    .option('--secret <name>', 'reference an existing keychain secret instead of prompting')
    .action(async (name: string, opts: { login?: boolean; apiKey?: boolean; authToken?: boolean; secret?: string }) => {
      const chosen = [opts.login && 'login', opts.apiKey && 'api-key', opts.authToken && 'auth-token'].filter(Boolean)
      if (chosen.length !== 1) throw new Error('specify exactly one of --login, --api-key, --auth-token')
      const mode = chosen[0] as AnthropicAuthMode
      const m = await requireManifest(ctx)
      const pr = m.profiles.find(p => p.name === name)
      if (!pr) throw new Error(`unknown profile: ${name}`)
      if ((pr.agent ?? 'claude') !== 'claude') throw new Error(`Anthropic auth applies to Claude profiles only; "${name}" is a codex profile`)

      let tokenRef: string | undefined
      if (mode !== 'login') {
        const secretName = opts.secret ?? `anthropic-${mode}-${name}`
        if (!opts.secret) {
          const value = await (ctx.promptSecret ?? readSecretMasked)(`Anthropic ${mode === 'api-key' ? 'API key' : 'auth token'} for ${name}`)
          if (!value.trim()) throw new Error('no value entered')
          const store = await secretsStore(ctx)
          await store.set(secretName, value.trim())
        }
        tokenRef = `secret://${secretName}`
      }
      // setAnthropicAuthMode throws on a custom base URL — surface it
      pr.settingsEnv = setAnthropicAuthMode(pr.settingsEnv, mode, tokenRef)
      await saveManifest(ctx.manifestRoot, m)
      const actions = await planActions(ctx, m)
      const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
      for (const line of r.performed) console.log(line)
      console.log(`provider: ${name} → ${mode}`)
    })
}
