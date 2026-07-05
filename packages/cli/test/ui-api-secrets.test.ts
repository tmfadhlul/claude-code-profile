import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { secretsStore } from '../src/commands/secrets.js'
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

  it('doctor flags a plaintext token sitting in the manifest (pre-migrate), quiets after migrate', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-4' } }))
    await callApi(ctx, 'POST', '/api/adopt') // manifest.settingsEnv.ANTHROPIC_AUTH_TOKEN is still plaintext here
    const before = await callApi(ctx, 'GET', '/api/doctor')
    expect(before._json.problems.join('\n')).toMatch(/plaintext token ANTHROPIC_AUTH_TOKEN in manifest for profile "default"/)
    await callApi(ctx, 'POST', '/api/secrets/migrate')
    const after = await callApi(ctx, 'GET', '/api/doctor')
    expect(after._json.problems.join('\n')).not.toMatch(/plaintext token/)
  })

  it('re-adopting after migrate preserves the secret ref instead of re-leaking plaintext', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'plain-tok-5' } }))
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/secrets/migrate')
    let row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://anthropic-auth-token-default')

    // re-adopt: live settings.json still carries the resolved plaintext value (migrate never
    // touches it) — buildManifest would naively re-import it as plaintext without preserveSecretRefs
    await callApi(ctx, 'POST', '/api/adopt')
    row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://anthropic-auth-token-default')
  })

  it('deleting a secret referenced by a profile settingsEnv is blocked (409)', async () => {
    await callApi(ctx, 'PUT', '/api/secrets/tok-a', { value: 'sk-a' })
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'PATCH', '/api/profiles/default', { settingsEnv: { ANTHROPIC_AUTH_TOKEN: 'secret://tok-a' } })
    const res = await callApi(ctx, 'DELETE', '/api/secrets/tok-a')
    expect(res._status).toBe(409)
    expect(res._json.error).toMatch(/referenced by profile "default"/)
    expect((await callApi(ctx, 'GET', '/api/secrets'))._json.names).toContain('tok-a')
  })

  it('status 409s with "secret not found" when a manifest secret ref goes missing', async () => {
    await callApi(ctx, 'PUT', '/api/secrets/tok-b', { value: 'sk-b' })
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'PATCH', '/api/profiles/default', { settingsEnv: { ANTHROPIC_AUTH_TOKEN: 'secret://tok-b' } })
    const store = await secretsStore(ctx)
    await store.delete('tok-b') // bypass the DELETE route's reference guard directly on the store
    const res = await callApi(ctx, 'GET', '/api/status')
    expect(res._status).toBe(409)
    expect(res._json.error).toMatch(/secret not found/)
  })

  it('GET /api/secrets returns backend "unavailable" instead of 500 when the store cannot open', async () => {
    // Force the linux code path (CCPROFILES_FORCE_OS is a test-only seam — see context.ts) with no
    // CCPROFILES_PASSPHRASE: defaultBackend() probes for `secret-tool`, which isn't installed on the
    // dev/CI box, so it falls through to the encrypted-file backend and throws for lack of a passphrase.
    const badCtx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh', CCPROFILES_FORCE_OS: 'linux' } as any)
    const res = await callApi(badCtx, 'GET', '/api/secrets')
    expect(res._status).toBe(200)
    expect(res._json.backend).toBe('unavailable')
    expect(res._json.names).toEqual([])
  })
})
