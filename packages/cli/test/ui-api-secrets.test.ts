import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uisec-'))
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
    await writeFile(join(home, '.zshrc'), 'export ANTHROPIC_API_KEY="sk-ant-LEGACY"\n')
    const res = await callApi(ctx, 'POST', '/api/secrets/migrate')
    expect(res._json.migrated).toContain('anthropic-api-key')
    expect((await callApi(ctx, 'GET', '/api/secrets/anthropic-api-key'))._json.value).toBe('sk-ant-LEGACY')
  })
})
