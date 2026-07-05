import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeContext } from '../src/context.js'
import { buildRoutes } from '../src/ui/api.js'
import { matchRoute } from '../src/ui/http.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', '..', 'ui', 'src', 'lib', 'api.ts')

let home: string, ctx: any
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ccp-uiparity-'))
  await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { emailAddress: 'a@b.c' },
  }))
  ctx = makeContext({ CCPROFILES_TEST_HOME: home, CCPROFILES_PASSPHRASE: 'pw', SHELL: '/bin/zsh' } as any)
})

/** Extract `req('METHOD', 'path')` / `req('METHOD', \`/tmpl/${x}\`)` calls from the client source. */
function extractCalls(src: string): { method: string; path: string }[] {
  const calls: { method: string; path: string }[] = []
  const re = /req\(\s*'([A-Z]+)'\s*,\s*(`[^`]*`|'[^']*')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const method = m[1]
    let rawPath = m[2]
    if (rawPath.startsWith('`')) {
      rawPath = rawPath.slice(1, -1).replace(/\$\{[^}]*\}/g, 'x')
    } else {
      rawPath = rawPath.slice(1, -1)
    }
    calls.push({ method, path: rawPath })
  }
  return calls
}

describe('ui api: client/server route parity', () => {
  it('every client api.ts call matches a server route', async () => {
    const src = await readFile(clientPath, 'utf8')
    const calls = extractCalls(src)
    expect(calls.length).toBeGreaterThan(0)

    const routes = buildRoutes(ctx)
    const unmatched: string[] = []
    for (const c of calls) {
      const found = matchRoute(routes, c.method, c.path)
      if (!found) unmatched.push(`${c.method} ${c.path}`)
    }
    expect(unmatched).toEqual([])
  })
})
