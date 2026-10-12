import { createServer } from 'node:http'
import type { CliContext } from '../context.js'
import { buildRoutes } from './api.js'
import { matchRoute, sendJson, HttpError } from './http.js'
import { tokenOk, originOk } from './token.js'
import { serveStatic } from './static.js'
import { withProgress } from '../progress.js'

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

    // A client that asks for progress gets NDJSON: one {step} line per step() the handler makes,
    // then a final {status, body} line carrying what the handler would have sent as plain JSON.
    let out = res
    let report = (_msg: string) => {}
    if (req.headers['x-ccp-progress'] === '1') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
      const line = (o: unknown) => res.write(JSON.stringify(o) + '\n')
      let status = 200
      out = {
        writeHead(code: number) { status = code; return out },
        end(text: string) { line({ status, body: JSON.parse(text) }); res.end(); return out },
      } as unknown as typeof res
      report = msg => line({ step: msg })
    }
    try {
      await withProgress(report, () => m.route.handler(m.match, req, out))
    } catch (e) {
      if (e instanceof HttpError) return sendJson(out, e.status, { error: e.message })
      process.stderr.write(`ui api error: ${(e as Error).stack ?? e}\n`)
      return sendJson(out, 500, { error: 'internal error' })
    }
  })

  await new Promise<void>(resolve => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))) }
}
