import { describe, it, expect } from 'vitest'
import { handshakeKeys, deriveSharedKey, sealJson, openJson, pinMac, newSalt } from '../src/crypto.js'

describe('crypto', () => {
  it('both sides derive the same key', () => {
    const a = handshakeKeys()
    const b = handshakeKeys()
    const salt = newSalt()
    const ka = deriveSharedKey(a.privateKey, b.publicRaw, salt)
    const kb = deriveSharedKey(b.privateKey, a.publicRaw, salt)
    expect(ka.equals(kb)).toBe(true)
    expect(ka).toHaveLength(32)
  })
  it('seal/open round-trips and rejects tampering', () => {
    const a = handshakeKeys(); const b = handshakeKeys(); const salt = newSalt()
    const key = deriveSharedKey(a.privateKey, b.publicRaw, salt)
    const sealed = sealJson(key, { hello: 'world' })
    expect(openJson(key, sealed)).toEqual({ hello: 'world' })
    const tampered = { ...sealed, tag: Buffer.from('x'.repeat(16)).toString('base64') }
    expect(() => openJson(key, tampered)).toThrow()
  })
  it('pin mac differs by pin and role', () => {
    const key = Buffer.alloc(32, 7)
    expect(pinMac(key, 'client', '123456')).not.toBe(pinMac(key, 'client', '654321'))
    expect(pinMac(key, 'client', '123456')).not.toBe(pinMac(key, 'server', '123456'))
    expect(pinMac(key, 'client', '123456')).toBe(pinMac(key, 'client', '123456'))
  })
})
