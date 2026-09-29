import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContext } from '../src/context.js'
import { runFallback } from '../src/commands/fallback.js'
import { renderRcBlock, parseManifest } from '../../core/src/index.js'

function manifest(home: string) {
  return parseManifest(JSON.stringify({
    version: 1, hub: null, mcpServers: {}, marketplaces: {},
    profiles: [
      { name: 'oauth', dir: `${home}/.claude-oauth`, launcher: 'cl-oauth', auth: 'oauth', fallback: 'cl-lim' },
      { name: 'cl-lim', dir: `${home}/.claude-cl-lim`, launcher: 'cl-lim', auth: 'oauth', fallback: 'oauth' },
    ],
  }))
}

describe('automatic Claude fallback', () => {
  it.each([
    ['oauth', 'cl-lim', '.claude-oauth', '.claude-cl-lim'],
    ['cl-lim', 'oauth', '.claude-cl-lim', '.claude-oauth'],
  ])('switches %s to %s and resumes transcript', async (from, _to, sourceDir, targetDir) => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-fallback-test-'))
    const transcript = join(home, 'session.jsonl')
    const log = join(home, 'launches.jsonl')
    await writeFile(transcript, '{}\n')
    const fake = join(home, 'claude')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const env = process.env;
fs.appendFileSync(env.TEST_LOG, JSON.stringify({dir: env.CLAUDE_CONFIG_DIR, base: env.ANTHROPIC_BASE_URL, args: process.argv.slice(2)}) + '\\n');
if (env.CLAUDE_CONFIG_DIR.endsWith(env.TEST_START_DIR)) {
  fs.writeFileSync(env.CCPROFILES_FALLBACK_SIGNAL, JSON.stringify({error:'rate_limit', transcript_path:env.TEST_TRANSCRIPT}));
  setInterval(() => {}, 1000);
}
`)
    await chmod(fake, 0o755)
    const ctx = makeContext({
      ...process.env, CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh',
      PATH: `${home}:${process.env.PATH}`, TEST_LOG: log, TEST_TRANSCRIPT: transcript,
      TEST_START_DIR: sourceDir,
      ANTHROPIC_BASE_URL: 'https://wrong-provider.example',
    })
    expect(await runFallback(ctx, manifest(home), from, ['hello'])).toBe(0)
    const launches = (await readFile(log, 'utf8')).trim().split('\n').map(x => JSON.parse(x))
    expect(launches.map(x => x.dir)).toEqual([join(home, sourceDir), join(home, targetDir)])
    expect(launches[0].args).toContain('hello')
    expect(launches[1].args).toContain(transcript)
    expect(launches[1].args).toContain('--fork-session')
    expect(launches[1].base).toBeUndefined()
  })

  it('renders a supervisor call for configured profiles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-fallback-rc-'))
    const ctx = makeContext({ CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh' })
    const block = renderRcBlock(manifest(home), ctx.platform)
    expect(block).toContain('ccprofiles fallback run --from oauth -- "$@"')
    expect(block).toContain('ccprofiles fallback run --from cl-lim -- "$@"')
  })
})
