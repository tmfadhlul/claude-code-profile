import { createServer } from 'node:http'
import type { CliContext } from '../context.js'
import { buildRoutes } from './api.js'
import { matchRoute, sendJson, HttpError } from './http.js'
import { tokenOk, originOk } from './token.js'
import { serveStatic } from './static.js'

export async function startUiServer(
  ctx: CliContext,
  opts: { port?: number; token: string; uiDir: string },
): Promise<{ port: number; close: () => Promise<void> }> {
  const routes = buildRoutes(ctx)

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    if (!path.startsWith('/api/')) return serveStatic(res, url, opts.uiDir)

    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    if (!originOk(req.headers.origin, port)) return sendJson(res, 403, { error: 'bad origin' })
    if (!tokenOk(req.headers['x-ccp-token'] as string | undefined, opts.token)) return sendJson(res, 401, { error: 'unauthorized' })

    const m = matchRoute(routes, req.method ?? 'GET', path)
    if (!m) return sendJson(res, 404, { error: 'not found' })
    try {
      await m.route.handler(m.match, req, res)
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message })
      process.stderr.write(`ui api error: ${(e as Error).stack ?? e}\n`)
      return sendJson(res, 500, { error: 'internal error' })
    }
  })

  await new Promise<void>(resolve => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))) }
}
