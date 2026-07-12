import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram, type CliContext } from '../src/context.js'
import { loadManifest, saveManifest } from 'ccprofiles-core'
import { secretsStore } from '../src/commands/secrets.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-provider-'))
  await mkdir(join(home, '.claude-work'), { recursive: true })
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {}, oauthAccount: { emailAddress: 'a@b.c' } }))
})
function makeCtx(promptSecret: (label: string) => Promise<string>): CliContext {
  return { ...makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any), promptSecret }
}
function run(promptValue: string | null, ...args: string[]): Promise<void> {
  const ctx = makeCtx(async () => promptValue ?? '')
  return buildProgram(ctx).parseAsync(['node', 'ccp', ...args]) as unknown as Promise<void>
}

describe('provider cli', () => {
  it('anthropic --api-key prompts for the key, stores a secret, sets settingsEnv', async () => {
    await run(null, 'adopt', '--yes')
    await run('sk-ant-TESTKEY', 'provider', 'anthropic', 'work', '--api-key')
    const m = await loadManifest(join(home, '.ccprofiles'))
    const pr = m.profiles.find(p => p.name === 'work')!
    expect(pr.settingsEnv.ANTHROPIC_API_KEY).toMatch(/^secret:\/\//)
    expect(pr.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
  it('anthropic --login clears both token vars', async () => {
    await run(null, 'adopt', '--yes')
    await run('sk-ant-X', 'provider', 'anthropic', 'work', '--auth-token')
    await run(null, 'provider', 'anthropic', 'work', '--login')
    const m = await loadManifest(join(home, '.ccprofiles'))
    const pr = m.profiles.find(p => p.name === 'work')!
    expect(pr.settingsEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(pr.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('anthropic --login rejects a codex profile without prompting', async () => {
    await mkdir(join(home, '.codex-x'), { recursive: true })
    await writeFile(join(home, '.codex-x', 'config.toml'), 'model = "gpt-5-codex"\n')
    await writeFile(join(home, '.codex-x', 'auth.json'), '{"tokens":{}}')
    await run(null, 'adopt', '--yes')

    const promptSecret = vi.fn(async () => 'sk-ant-x')
    const ctx = makeCtx(promptSecret)
    await expect(buildProgram(ctx).parseAsync(['node', 'ccp', 'provider', 'anthropic', 'codex-x', '--login']))
      .rejects.toThrow(/codex profile/)
    expect(promptSecret).not.toHaveBeenCalled()
  })

  it('anthropic --api-key rejects a profile with a custom base URL and stores no secret', async () => {
    await run(null, 'adopt', '--yes')
    const manifestRoot = join(home, '.ccprofiles')
    const m = await loadManifest(manifestRoot)
    const pr = m.profiles.find(p => p.name === 'work')!
    pr.settingsEnv.ANTHROPIC_BASE_URL = 'https://custom-provider.example.com'
    await saveManifest(manifestRoot, m)

    const promptSecret = vi.fn(async () => 'sk-ant-should-not-be-stored')
    const ctx = makeCtx(promptSecret)
    await expect(buildProgram(ctx).parseAsync(['node', 'ccp', 'provider', 'anthropic', 'work', '--api-key']))
      .rejects.toThrow(/custom provider base URL/)
    expect(promptSecret).not.toHaveBeenCalled()

    const store = await secretsStore(ctx)
    const names = await store.list()
    expect(names).not.toContain('anthropic-api-key-work')
  })

  it('anthropic --api-key --secret <name> references an existing secret without prompting', async () => {
    await run(null, 'adopt', '--yes')
    const ctx = makeCtx(async () => { throw new Error('promptSecret should not be called') })
    const store = await secretsStore(ctx)
    await store.set('preexisting-key', 'sk-ant-preexisting')

    const promptSecret = vi.fn(async () => 'sk-ant-should-not-be-used')
    const spiedCtx = makeCtx(promptSecret)
    await buildProgram(spiedCtx).parseAsync(['node', 'ccp', 'provider', 'anthropic', 'work', '--api-key', '--secret', 'preexisting-key'])
    expect(promptSecret).not.toHaveBeenCalled()

    const m = await loadManifest(join(home, '.ccprofiles'))
    const pr = m.profiles.find(p => p.name === 'work')!
    expect(pr.settingsEnv.ANTHROPIC_API_KEY).toBe('secret://preexisting-key')
  })
})
