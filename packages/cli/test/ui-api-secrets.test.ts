import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'
import { envKeyLine, seedRc } from './helpers.js'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uisec-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: secrets', () => {
  it('set, list (names only), reveal, delete', async () => {
    await callApi(ctx, 'PUT', '/api/secrets/api-key', { value: 'sk-ant-xyz' })
    const list = await callApi(ctx, 'GET', '/api/secrets')
    expect(list._json.names).toContain('api-key')
    expect(JSON.stringify(list._json)).not.toContain('sk-ant-xyz')
    const rev = await callApi(ctx, 'GET', '/api/secrets/api-key')
    expect(rev._json.value).toBe('sk-ant-xyz')
    await callApi(ctx, 'DELETE', '/api/secrets/api-key')
    expect((await callApi(ctx, 'GET', '/api/secrets'))._json.names).not.toContain('api-key')
  })
  it('reveal of missing secret 404s', async () => {
    const res = await callApi(ctx, 'GET', '/api/secrets/nope')
    expect(res._status).toBe(404)
  })
  it('migrate moves rc keys', async () => {
    await seedRc(home, envKeyLine('ANTHROPIC_API_KEY', 'sk-ant-LEGACY') + '\n')
    const res = await callApi(ctx, 'POST', '/api/secrets/migrate')
    expect(res._json.migrated).toContain('anthropic-api-key')
    expect((await callApi(ctx, 'GET', '/api/secrets/anthropic-api-key'))._json.value).toBe('sk-ant-LEGACY')
  })
  it('migrate moves settings.json token from manifest to keychain ref', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-1', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    }))
    await callApi(ctx, 'POST', '/api/adopt') // imports plaintext settingsEnv into manifest
    const res = await callApi(ctx, 'POST', '/api/secrets/migrate')
    expect(res._json.migrated).toContain('anthropic-auth-token-default')
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://anthropic-auth-token-default')
    expect((await callApi(ctx, 'GET', '/api/secrets/anthropic-auth-token-default'))._json.value).toBe('plain-tok-1')
    // live settings.json still carries the plaintext value (Claude Code must read it)
    const s = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe('plain-tok-1')
  })
  it('doctor flags unmanaged plaintext token in settings.json', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-2' } }))
    const res = await callApi(ctx, 'GET', '/api/doctor')
    expect(res._json.problems.join('\n')).toMatch(/plaintext token ANTHROPIC_AUTH_TOKEN/)
  })
  it('doctor is quiet once the token is manifest-managed', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-3' } }))
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/secrets/migrate')
    const res = await callApi(ctx, 'GET', '/api/doctor')
    expect(res._json.problems.join('\n')).not.toMatch(/plaintext token/)
  })
})
