import { deriveSharedKey, handshakeKeys, openJson, pinMac, sealJson, type Sealed } from './crypto.js'
import type { DeviceEntry } from './devices.js'

async function post(host: string, port: number, path: string, payload: unknown): Promise<any> {
  let res: Response
  try {
    res = await fetch(`http://${host}:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error(`cannot reach ${host}:${port} — is \`ccp serve\` running on the other device?`)
  }
  const data: any = await res.json()
  if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`)
  return data
}

/** PIN-authenticated ECDH pairing. Throws if the server can't prove it knows the PIN. */
export async function pairWithServer(host: string, port: number, pin: string, name: string): Promise<DeviceEntry> {
  const { privateKey, publicRaw } = handshakeKeys()
  const { serverPub, salt } = await post(host, port, '/pair', { clientPub: publicRaw })
  const key = deriveSharedKey(privateKey, serverPub, salt)
  const { mac, token } = await post(host, port, '/pair/confirm', { mac: pinMac(key, 'client', pin), name })
  if (mac !== pinMac(key, 'server', pin)) throw new Error('server failed PIN verification — possible MITM, aborting')
  return { name, host, port, token, key: key.toString('base64') }
}

export async function fetchRemote(device: DeviceEntry): Promise<{ manifestYaml: string; assets: Record<string, string> }> {
  const { sealed } = await post(device.host, device.port, '/manifest', { token: device.token })
  return openJson(Buffer.from(device.key, 'base64'), sealed as Sealed)
}

export async function fetchSecrets(device: DeviceEntry, names: string[]): Promise<Record<string, string>> {
  const key = Buffer.from(device.key, 'base64')
  const { sealed } = await post(device.host, device.port, '/secrets', { token: device.token, sealed: sealJson(key, { names }) })
  return openJson(key, sealed as Sealed)
}
