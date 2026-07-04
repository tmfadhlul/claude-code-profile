import {
  createCipheriv, createDecipheriv, createHmac, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject,
} from 'node:crypto'

export interface Sealed { iv: string; tag: string; data: string }

/** X25519 keypair for the pairing handshake. */
export function handshakeKeys(): { privateKey: KeyObject; publicRaw: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const raw = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { privateKey, publicRaw: raw }
}

/** ECDH(private, peerPublic) → HKDF-SHA256 with salt → 32-byte key. */
export function deriveSharedKey(privateKey: KeyObject, peerPublicRaw: string, salt: string): Buffer {
  const peer = createPublicKey({ key: Buffer.from(peerPublicRaw, 'base64'), type: 'spki', format: 'der' })
  const secret = diffieHellman({ privateKey, publicKey: peer })
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(salt, 'base64'), 'ccprofiles-pairing', 32))
}

export function sealJson(key: Buffer, obj: unknown): Sealed {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function openJson<T = unknown>(key: Buffer, sealed: Sealed): T {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  const text = d.update(Buffer.from(sealed.data, 'base64')).toString('utf8') + d.final('utf8')
  return JSON.parse(text) as T
}

/** PIN-bound confirmation MAC over the handshake — proves both sides know the PIN. */
export function pinMac(key: Buffer, role: 'client' | 'server', pin: string): string {
  return createHmac('sha256', key).update(`ccprofiles:${role}:${pin}`).digest('base64')
}

export function newSalt(): string { return randomBytes(16).toString('base64') }
export function newToken(): string { return randomBytes(32).toString('base64url') }
export function newPin(): string { return String(Math.floor(100000 + Math.random() * 900000)) }
