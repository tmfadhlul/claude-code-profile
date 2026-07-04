import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { buildRoutes } from '../src/ui/api.js'
import { matchRoute } from '../src/ui/http.js'
import type { CliContext } from '../src/context.js'

export function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = method; req.url = url
  // Feed the body through the Readable buffer (push), so `for await (…of req)` drains it.
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  return req
}

export function fakeRes(): ServerResponse & { _status?: number; _json?: any } {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as any
  let chunks = ''
  res.writeHead = (code: number) => { res._status = code; return res }
  res.end = (t?: string) => { if (t) { chunks += t; try { res._json = JSON.parse(chunks) } catch { /* non-json */ } } return res }
  res.write = (t: string) => { chunks += t; return true }
  return res
}

/** Invoke a single API route handler directly (bypasses the token/origin guard). */
export async function callApi(ctx: CliContext, method: string, path: string, body?: unknown) {
  const m = matchRoute(buildRoutes(ctx), method, path)
  if (!m) throw new Error(`no route ${method} ${path}`)
  const res = fakeRes()
  try { await m.route.handler(m.match, fakeReq(method, path, body), res) }
  catch (e: any) { res._status = e.status ?? 500; res._json = { error: e.message } }
  return res
}
