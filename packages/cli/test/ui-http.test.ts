import { describe, it, expect } from 'vitest'
import { matchRoute, HttpError, type Route } from '../src/ui/http.js'

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
