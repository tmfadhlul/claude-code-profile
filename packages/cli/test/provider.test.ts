import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext, buildProgram } from '../src/context.js'
import { loadManifest } from 'ccprofiles-core'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-provider-'))
  await mkdir(join(home, '.claude-work'), { recursive: true })
  await writeFile(join(home, '.claude-work', '.claude.json'), JSON.stringify({ mcpServers: {}, oauthAccount: { emailAddress: 'a@b.c' } }))
})
function run(promptValue: string | null, ...args: string[]): Promise<void> {
  const ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any),
    promptSecret: async () => promptValue ?? '' }
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
})
