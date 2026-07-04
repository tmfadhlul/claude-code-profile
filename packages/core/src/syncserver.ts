import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deriveSharedKey, handshakeKeys, newPin, newSalt, newToken, openJson, pinMac, sealJson, type Sealed,
} from './crypto.js'
import { parseManifest } from './manifest.js'
import { collectAssets } from './assets.js'
import { loadDevices, saveDevices, type DeviceEntry } from './devices.js'
import type { Platform } from './platform.js'

export interface SyncServerDeps {
  manifestRoot: string
  platform: Platform
  allowSecrets?: boolean
  /** resolve secret values by name (from the local store) when --allow-secrets */
  secretValues?: (names: string[]) => Promise<Record<string, string>>
  port?: number
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

function macEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'base64'); const bb = Buffer.from(b, 'base64')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export async function startSyncServer(deps: SyncServerDeps): Promise<{ port: number; pin: string; close: () => Promise<void> }> {
  const pin = deps.pin ?? newPin()
  let pending: Pending | null = null

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
      const payload = await body(req)

      if (req.url === '/pair') {
        const { privateKey, publicRaw } = handshakeKeys()
        const salt = newSalt()
        const key = deriveSharedKey(privateKey, payload.clientPub, salt)
        pending = { privateKey, salt, key }
        return send(res, 200, { serverPub: publicRaw, salt })
      }

      if (req.url === '/pair/confirm') {
        if (!pending) return send(res, 400, { error: 'no pending handshake' })
        const { key } = pending
        pending = null
        if (!macEqual(payload.mac, pinMac(key, 'client', pin))) return send(res, 403, { error: 'pin mismatch' })
        const token = newToken()
        const devices = await loadDevices(deps.manifestRoot)
        devices.push({ name: payload.name ?? 'peer', host: '-', port: 0, token, key: key.toString('base64') })
        await saveDevices(deps.manifestRoot, devices)
        return send(res, 200, { mac: pinMac(key, 'server', pin), token })
      }

      // authenticated endpoints: find device by token, decrypt/encrypt with its key
      const devices = await loadDevices(deps.manifestRoot)
      const device = devices.find(d => d.token === payload.token)
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
      return send(res, 500, { error: (e as Error).message })
    }
  })

  await new Promise<void>(resolve => server.listen(deps.port ?? 0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    pin,
    close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  }
}
