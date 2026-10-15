import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { runAutoFixes } from '../src/commands/fix.js'
import { syncClaudeMemAuth } from '../src/commands/claudemem.js'

let home: string, ctx: any
async function profile(dir: string, opts: { oauth?: boolean; env?: Record<string, string> } = {}) {
  await mkdir(join(home, dir, 'plugins', 'cache', 'thedotmack', 'claude-mem', '13.39.0'), { recursive: true })
  await writeFile(join(home, dir, '.claude.json'), JSON.stringify(opts.oauth ? { oauthAccount: { emailAddress: 'a@b' } } : {}))
  await writeFile(join(home, dir, 'settings.json'), JSON.stringify({ env: opts.env ?? {} }))
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-cmem-'))
  ctx = { ...makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any), pluginRunner: {} }
})

describe('claude-mem credentials', () => {
  it('does nothing when claude-mem is not installed', async () => {
    await mkdir(join(home, '.claude-x'), { recursive: true })
    await writeFile(join(home, '.claude-x', '.claude.json'), '{}')
    expect(await syncClaudeMemAuth(ctx)).toEqual({ changed: [] })
  })

  it('token-only user: fix writes the key into ~/.claude-mem/.env at 0600, then converges', async () => {
    await profile('.claude-api', { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })
    const doc = await syncClaudeMemAuth(ctx, { dryRun: true })
    expect(doc.changed).toHaveLength(1)
    const { fixed } = await runAutoFixes(ctx)
    expect(fixed.some(f => /claude-mem: now uses api-key of profile "api"/.test(f))).toBe(true)
    const env = join(home, '.claude-mem', '.env')
    expect(await readFile(env, 'utf8')).toContain('ANTHROPIC_API_KEY=sk-ant-test')
    expect((await stat(env)).mode & 0o777).toBe(0o600)
    expect(await syncClaudeMemAuth(ctx)).toEqual({ changed: [] })
    expect(await syncClaudeMemAuth(ctx, { dryRun: true })).toEqual({ changed: [] })
  })

  it('OAuth beats the key profile and points claude-mem at that profile dir', async () => {
    await profile('.claude-api', { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })
    await profile('.claude-work', { oauth: true })
    await mkdir(join(home, '.claude-mem'))
    await writeFile(join(home, '.claude-mem', 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '1' }), { mode: 0o640 })
    await syncClaudeMemAuth(ctx)
    const s = JSON.parse(await readFile(join(home, '.claude-mem', 'settings.json'), 'utf8'))
    expect(s).toMatchObject({ CLAUDE_MEM_WORKER_PORT: '1', CLAUDE_MEM_CLAUDE_CONFIG_DIR: join(home, '.claude-work'), CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' })
    expect((await stat(join(home, '.claude-mem', 'settings.json'))).mode & 0o777).toBe(0o640)
  })

  it('reports, rather than fixes, a setup where nothing can authenticate', async () => {
    await profile('.claude-x')
    expect((await syncClaudeMemAuth(ctx, { dryRun: true })).problem).toMatch(/no profile has an OAuth login or an API key/)
  })

  it('a corrupt claude-mem settings.json aborts instead of being overwritten', async () => {
    await profile('.claude-work', { oauth: true })
    await mkdir(join(home, '.claude-mem'))
    await writeFile(join(home, '.claude-mem', 'settings.json'), '{oops')
    await expect(syncClaudeMemAuth(ctx)).rejects.toThrow(/cannot read/)
    expect(await readFile(join(home, '.claude-mem', 'settings.json'), 'utf8')).toBe('{oops')
  })
})
