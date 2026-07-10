import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'
import { parseManifest, serializeManifest } from 'ccprofiles-core'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uiapi-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: adopt/profiles/status/apply/doctor', () => {
  it('adopt then profiles lists the discovered profile', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'GET', '/api/profiles')
    expect(res._json.find((p: any) => p.name === 'default').account).toBe('a@b.c')
  })
  it('status is not-in-sync before apply, in-sync after', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    expect((await callApi(ctx, 'GET', '/api/status'))._json.inSync).toBe(false)
    await callApi(ctx, 'POST', '/api/apply')
    expect((await callApi(ctx, 'GET', '/api/status'))._json.inSync).toBe(true)
  })
  it('create profile via POST', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/profiles', { name: 'work', from: 'default' })
    const names = (await callApi(ctx, 'GET', '/api/profiles'))._json.map((p: any) => p.name)
    expect(names).toContain('work')
  })
  it('status without a manifest 409s with a hint', async () => {
    const res = await callApi(ctx, 'GET', '/api/status')
    expect(res._status).not.toBe(200)
    expect(res._json.error).toMatch(/no manifest/)
  })
  it('doctor returns problems array', async () => {
    const res = await callApi(ctx, 'GET', '/api/doctor')
    expect(Array.isArray(res._json.problems)).toBe(true)
  })
  it('profiles include env, links, and mcpNames from the manifest', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'PATCH', '/api/profiles/default', { env: { FOO: 'bar' } })
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.env).toEqual({ FOO: 'bar' })
    expect(row.mcpNames).toEqual(['playwright'])
    expect(row.links).toEqual({})
  })
  it('DELETE removes profile from manifest and rc but keeps the dir', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/profiles', { name: 'work' })
    expect(await readFile(ctx.platform.rcFile, 'utf8')).toContain('cl-work')
    const del = await callApi(ctx, 'DELETE', '/api/profiles/work')
    expect(del._json.ok).toBe(true)
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'work')
    expect(row.adopted).toBe(false)
    expect(existsSync(join(home, '.claude-work'))).toBe(true)
    expect(await readFile(ctx.platform.rcFile, 'utf8')).not.toContain('cl-work')
  })
  it('DELETE unknown profile 404s', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    expect((await callApi(ctx, 'DELETE', '/api/profiles/nope'))._status).toBe(404)
  })
  it('PATCH with an unsafe launcher 400s and does not corrupt the manifest', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { launcher: 'x(){ :;};evil' })
    expect(res._status).toBe(400)
    const after = await callApi(ctx, 'GET', '/api/profiles')
    expect(after._status).toBe(200)
  })
  it('PATCH with an empty secret ref 400s', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { env: { FOO: 'secret://' } })
    expect(res._status).toBe(400)
  })
  it('DELETE the hub profile is rejected', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const mp = join(ctx.manifestRoot, 'manifest.yaml')
    const m = parseManifest(await readFile(mp, 'utf8'))
    m.hub = 'default'
    await writeFile(mp, serializeManifest(m))
    const res = await callApi(ctx, 'DELETE', '/api/profiles/default')
    expect(res._status).toBe(400)
    expect(res._json.error).toMatch(/hub/)
  })
  it('PATCH settingsEnv with a secret ref applies resolved value into settings.json, preserving other keys', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
    await callApi(ctx, 'PUT', '/api/secrets/z-token', { value: 'tok-abc' })
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', {
      settingsEnv: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'secret://z-token' },
    })
    expect(res._status).toBe(200)
    const s = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(s.model).toBe('opus')
    expect(s.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok-abc' })
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('secret://z-token') // manifest keeps the ref, not the value
  })
  it('PATCH settingsEnv with missing secret 400s and does not write settings.json', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { settingsEnv: { T: 'secret://ghost' } })
    expect(res._status).toBe(400)
    expect(res._json.error).toMatch(/secret not found: ghost/)
  })
  it('PATCH settingsEnv rejects non-string values', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { settingsEnv: { N: 42 } })
    expect(res._status).toBe(400)
  })
  it('PATCH skipPermissions renders the flag into the launcher and GET returns it', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'POST', '/api/profiles', { name: 'work' })   // gets launcher cl-work
    const res = await callApi(ctx, 'PATCH', '/api/profiles/work', { skipPermissions: true })
    expect(res._status).toBe(200)
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'work')
    expect(row.skipPermissions).toBe(true)
    const rc = await readFile(ctx.platform.rcFile, 'utf8')
    expect(rc).toContain('claude --dangerously-skip-permissions "$@"')
  })
  it('PATCH skipPermissions rejects a non-boolean', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { skipPermissions: 'yes' })
    expect(res._status).toBe(400)
  })
  it('skipPermissions is forced off for a launcherless profile (default)', async () => {
    await callApi(ctx, 'POST', '/api/adopt')  // default profile has no launcher
    await callApi(ctx, 'PATCH', '/api/profiles/default', { skipPermissions: true })
    const row = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'default')
    expect(row.skipPermissions).toBe(false)
  })
  it('PATCH sharedSessions sets the flag and GET returns it', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedSessions: true })
    expect(res._status).toBe(200)
    const rows = (await callApi(ctx, 'GET', '/api/profiles'))._json
    expect(rows.find((r: any) => r.name === 'default').sharedSessions).toBe(true)
  })
  it('PATCH sharedSessions rejects a non-boolean', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const res = await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedSessions: 'yes' })
    expect(res._status).toBe(400)
  })
  it('GET /api/sessions returns pooled projects', async () => {
    await mkdir(join(home, '.claude', 'projects', 'proj'), { recursive: true })
    await writeFile(join(home, '.claude', 'projects', 'proj', 's1.jsonl'),
      '{"type":"user","cwd":"/tmp/proj","message":{"content":"hi there"}}\n')
    await callApi(ctx, 'POST', '/api/adopt')
    await callApi(ctx, 'PATCH', '/api/profiles/default', { sharedSessions: true })
    const rows = (await callApi(ctx, 'GET', '/api/sessions'))._json
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.some((r: any) => r.project && Array.isArray(r.sessions))).toBe(true)
  })
  it('UI create/share/list works for Codex profiles', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const created = await callApi(ctx, 'POST', '/api/profiles', { name: 'work', agent: 'codex' })
    expect(created._json.name).toBe('codex-work')
    const dated = join(home, '.codex-work', 'sessions', '2026', '07', '10')
    await mkdir(dated, { recursive: true })
    await writeFile(join(dated, 'rollout-44444444-4444-4444-8444-444444444444.jsonl'),
      '{"type":"session_meta","payload":{"id":"44444444-4444-4444-8444-444444444444","cwd":"/tmp/ui-codex"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"from UI"}]}}\n')
    const shared = await callApi(ctx, 'PATCH', '/api/profiles/codex-work', { sharedSessions: true })
    expect(shared._status).toBe(200)
    const profile = (await callApi(ctx, 'GET', '/api/profiles'))._json.find((p: any) => p.name === 'codex-work')
    expect(profile).toMatchObject({ agent: 'codex', launcher: 'cx-work', sharedSessions: true })
    const sessions = (await callApi(ctx, 'GET', '/api/sessions'))._json
    expect(sessions.find((p: any) => p.project === '/tmp/ui-codex')).toMatchObject({ agent: 'codex', scope: 'shared' })
  })
  it('UI safely merges existing Codex skills and prompts into the shared Claude hub', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const manifestPath = join(ctx.manifestRoot, 'manifest.yaml')
    const m = parseManifest(await readFile(manifestPath, 'utf8'))
    m.hub = 'default'
    await writeFile(manifestPath, serializeManifest(m))
    await mkdir(join(home, '.codex-work', 'skills', 'codex-only'), { recursive: true })
    await mkdir(join(home, '.codex-work', 'prompts'), { recursive: true })
    await writeFile(join(home, '.codex-work', 'skills', 'codex-only', 'SKILL.md'), '# codex skill')
    await writeFile(join(home, '.codex-work', 'prompts', 'review.md'), '# review prompt')

    const created = await callApi(ctx, 'POST', '/api/profiles', { name: 'work', agent: 'codex' })
    expect(created._status).toBe(200)
    expect((await lstat(join(home, '.codex-work', 'skills'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(home, '.codex-work', 'prompts'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(home, '.claude', 'skills', 'codex-only', 'SKILL.md'), 'utf8')).toBe('# codex skill')
    expect(await readFile(join(home, '.claude', 'commands', 'review.md'), 'utf8')).toBe('# review prompt')
  })
})
