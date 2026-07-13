import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deriveSharedKey, handshakeKeys, newPin, newSalt, newToken, openJson, pinMac, sealJson, type Sealed,
} from './crypto.js'
import { parseManifest } from './manifest.js'
import { collectAssets } from './assets.js'
import { loadDevices, saveDevices } from './devices.js'
import type { Platform } from './platform.js'

/** After this many failed PIN confirmations the server refuses further pairing (brute-force guard). */
export const MAX_PIN_ATTEMPTS = 5

export interface SyncServerDeps {
  manifestRoot: string
  platform: Platform
  allowSecrets?: boolean
  /** resolve secret values by name (from the local store) when --allow-secrets */
  secretValues?: (names: string[]) => Promise<Record<string, string>>
  port?: number
  /** interface to bind (default 0.0.0.0 — all interfaces, needed for LAN peers) */
  host?: string
  /** override the generated PIN (tests) */
  pin?: string
}

interface Pending { privateKey: KeyObject; salt: string; key: Buffer }

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** Constant-time base64 comparison; false on length mismatch (never throws). */
function ctEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ''), 'base64')
  const bb = Buffer.from(String(b ?? ''), 'base64')
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb)
}

/** Constant-time comparison of the opaque device tokens (base64url strings). */
function ctEqualToken(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb)
}

export async function startSyncServer(
  deps: SyncServerDeps,
): Promise<{ port: number; host: string; pin: string; close: () => Promise<void> }> {
  const pin = deps.pin ?? newPin()
  const host = deps.host ?? '0.0.0.0'
  // per-handshake state keyed by a server-issued id — no shared global, no cross-client clobber
  const handshakes = new Map<string, Pending>()
  let failedAttempts = 0
  let locked = false

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
      const payload = await body(req).catch(() => null)
      if (payload === null) return send(res, 400, { error: 'invalid request body' })

      if (req.url === '/pair') {
        if (locked) return send(res, 429, { error: 'pairing locked after too many failed attempts — restart ccprofiles serve' })
        const { privateKey, publicRaw } = handshakeKeys()
        const salt = newSalt()
        const key = deriveSharedKey(privateKey, payload.clientPub, salt)
        const handshakeId = newToken()
        handshakes.set(handshakeId, { privateKey, salt, key })
        return send(res, 200, { handshakeId, serverPub: publicRaw, salt })
      }

      if (req.url === '/pair/confirm') {
        if (locked) return send(res, 429, { error: 'pairing locked after too many failed attempts — restart ccprofiles serve' })
        const pending = typeof payload.handshakeId === 'string' ? handshakes.get(payload.handshakeId) : undefined
        if (!pending) return send(res, 400, { error: 'no pending handshake (call /pair first)' })
        handshakes.delete(payload.handshakeId) // one shot per handshake
        if (!ctEqual(payload.mac, pinMac(pending.key, 'client', pin))) {
          if (++failedAttempts >= MAX_PIN_ATTEMPTS) locked = true
          return send(res, 403, { error: 'pin mismatch', attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - failedAttempts) })
        }
        failedAttempts = 0 // successful pair resets the counter
        const token = newToken()
        const devices = await loadDevices(deps.manifestRoot)
        devices.push({ name: String(payload.name ?? 'peer'), host: '-', port: 0, token, key: pending.key.toString('base64') })
        await saveDevices(deps.manifestRoot, devices)
        return send(res, 200, { mac: pinMac(pending.key, 'server', pin), token })
      }

      // authenticated endpoints: match device by constant-time token compare
      const devices = await loadDevices(deps.manifestRoot)
      const device = typeof payload.token === 'string'
        ? devices.find(d => ctEqualToken(d.token, payload.token))
        : undefined
      if (!device) return send(res, 401, { error: 'unknown token' })
      const key = Buffer.from(device.key, 'base64')

      if (req.url === '/manifest') {
        const manifestYaml = await readFile(join(deps.manifestRoot, 'manifest.yaml'), 'utf8')
        const assets = await collectAssets(parseManifest(manifestYaml), deps.platform)
        return send(res, 200, { sealed: sealJson(key, { manifestYaml, assets }) })
      }

      if (req.url === '/secrets') {
        if (!deps.allowSecrets || !deps.secretValues) return send(res, 403, { error: 'secrets transfer not enabled (serve --allow-secrets)' })
        const names: string[] = payload.sealed ? openJson<{ names: string[] }>(key, payload.sealed as Sealed).names : []
        const values = await deps.secretValues(names)
        return send(res, 200, { sealed: sealJson(key, values) })
      }

      return send(res, 404, { error: 'not found' })
    } catch (e) {
      // never leak internal error detail (paths, parse internals) to callers — but log it
      // locally (this process's own stderr, never sent over the wire) so whoever runs
      // `ccprofiles serve` can actually diagnose the failure instead of a bare 500.
      process.stderr.write(`ccprofiles serve error: ${(e as Error).stack ?? e}\n`)
      return send(res, 500, { error: 'internal error' })
    }
  })

  await new Promise<void>(resolve => server.listen(deps.port ?? 0, host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    host,
    pin,
    close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  }
}
