import { describe, it, expect } from 'vitest'
import { newUiToken, tokenOk, originOk } from '../src/ui/token.js'

describe('ui token', () => {
  it('generates distinct urlsafe tokens', () => {
    const a = newUiToken(), b = newUiToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('accepts the exact token, rejects wrong/missing', () => {
    const t = newUiToken()
    expect(tokenOk(t, t)).toBe(true)
    expect(tokenOk('nope', t)).toBe(false)
    expect(tokenOk(undefined, t)).toBe(false)
  })
})

describe('origin guard', () => {
  it('allows absent origin (same-process/curl)', () => {
    expect(originOk(undefined, 5000)).toBe(true)
  })
  it('allows loopback origins on the right port', () => {
    expect(originOk('http://127.0.0.1:5000', 5000)).toBe(true)
    expect(originOk('http://localhost:5000', 5000)).toBe(true)
  })
  it('rejects foreign origins and wrong ports', () => {
    expect(originOk('http://evil.com', 5000)).toBe(false)
    expect(originOk('http://127.0.0.1:5001', 5000)).toBe(false)
  })
})
