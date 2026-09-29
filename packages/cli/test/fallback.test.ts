import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
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
    await writeFile(transcript, '{}\n')
    const launches: { dir: string; base?: string; args: string[] }[] = []
    const spawnClaude = ((_command: string, args: string[], options: { env: Record<string, string> }) => {
      const env = options.env
      launches.push({ dir: env.CLAUDE_CONFIG_DIR, base: env.ANTHROPIC_BASE_URL, args })
      const child = new EventEmitter() as ChildProcess
      child.kill = (() => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true }) as ChildProcess['kill']
      if (env.CLAUDE_CONFIG_DIR === join(home, sourceDir)) {
        void writeFile(env.CCPROFILES_FALLBACK_SIGNAL, JSON.stringify({ error: 'rate_limit', transcript_path: transcript }))
          .catch(error => child.emit('error', error))
      } else queueMicrotask(() => child.emit('exit', 0, null))
      return child
    }) as typeof import('node:child_process').spawn
    const ctx = makeContext({
      ...process.env, CCPROFILES_TEST_HOME: home, SHELL: '/bin/zsh',
      ANTHROPIC_BASE_URL: 'https://wrong-provider.example',
    })
    expect(await runFallback(ctx, manifest(home), from, ['hello'], spawnClaude)).toBe(0)
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
    const args = process.platform === 'win32' ? '@args' : '"$@"'
    expect(block).toContain(`ccprofiles fallback run --from oauth -- ${args}`)
    expect(block).toContain(`ccprofiles fallback run --from cl-lim -- ${args}`)
  })
})
