import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export class BadRequest extends HttpError {
  constructor(message = 'invalid request') { super(400, message) }
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJson<T = any>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req)
  if (!raw) return {} as T
  try { return JSON.parse(raw) as T } catch { throw new BadRequest('invalid JSON body') }
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export type Route = {
  method: string
  pattern: RegExp
  handler: (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse) => Promise<void>
}

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; match: RegExpMatchArray } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const match = path.match(route.pattern)
    if (match) return { route, match }
  }
  return null
}
