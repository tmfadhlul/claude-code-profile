import { describe, it, expect } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { matchRoute, HttpError, readBody, MAX_BODY_BYTES, type Route } from '../src/ui/http.js'

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/secrets$/, handler: async () => {} },
  { method: 'GET', pattern: /^\/api\/secrets\/([^/]+)$/, handler: async () => {} },
]

describe('matchRoute', () => {
  it('matches a static route', () => {
    const r = matchRoute(routes, 'GET', '/api/secrets')
    expect(r?.route.pattern.source).toBe('^\\/api\\/secrets$')
  })
  it('captures a param', () => {
    const r = matchRoute(routes, 'GET', '/api/secrets/api-key')
    expect(r?.match[1]).toBe('api-key')
  })
  it('returns null on method mismatch', () => {
    expect(matchRoute(routes, 'POST', '/api/secrets')).toBeNull()
  })
  it('returns null on no path match', () => {
    expect(matchRoute(routes, 'GET', '/api/nope')).toBeNull()
  })
})

describe('HttpError', () => {
  it('carries a status', () => {
    expect(new HttpError(409, 'x').status).toBe(409)
  })
})

function reqWithBody(bytes: number): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.push(Buffer.alloc(bytes, 'a'))
  req.push(null)
  return req
}

describe('readBody size cap', () => {
  it('accepts a body at the cap', async () => {
    await expect(readBody(reqWithBody(MAX_BODY_BYTES))).resolves.toHaveLength(MAX_BODY_BYTES)
  })
  it('rejects a body over the cap with a 413 HttpError', async () => {
    await expect(readBody(reqWithBody(MAX_BODY_BYTES + 1))).rejects.toMatchObject({ status: 413, message: 'request too large' })
  })
})
