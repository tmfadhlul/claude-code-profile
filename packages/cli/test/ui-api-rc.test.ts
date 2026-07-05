import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { callApi } from './ui-helpers.js'

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uirc-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

describe('ui api: rc', () => {
  it('GET reports missing block, POST writes it, GET reports in sync', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    const before = (await callApi(ctx, 'GET', '/api/rc'))._json
    expect(before.rcFile).toBe(ctx.platform.rcFile)
    expect(before.current).toBeNull()
    expect(before.inSync).toBe(false)
    expect(before.rendered).toContain('# >>> ccprofiles managed >>>')

    const post = (await callApi(ctx, 'POST', '/api/rc'))._json
    expect(post.ok).toBe(true)

    const after = (await callApi(ctx, 'GET', '/api/rc'))._json
    expect(after.inSync).toBe(true)
    expect(after.current).toBe(after.rendered)
  })

  it('POST preserves content outside the managed block and backs up the rc file', async () => {
    await callApi(ctx, 'POST', '/api/adopt')
    await writeFile(ctx.platform.rcFile, '# my stuff\nalias ll="ls -l"\n')
    const res = (await callApi(ctx, 'POST', '/api/rc'))._json
    expect(res.backupDir).toBeTruthy()
    const rc = await readFile(ctx.platform.rcFile, 'utf8')
    expect(rc).toContain('alias ll')
    expect(rc).toContain('# >>> ccprofiles managed >>>')
    const backup = await readFile(join(res.backupDir, (ctx.platform.rcFile as string).replace(/:/g, '').replace(/[\\/]+/g, '__').replace(/^__/, '')), 'utf8')
    expect(backup).toBe('# my stuff\nalias ll="ls -l"\n')
  })

  it('GET without a manifest 409s', async () => {
    const res = await callApi(ctx, 'GET', '/api/rc')
    expect(res._status).toBe(409)
  })
})
