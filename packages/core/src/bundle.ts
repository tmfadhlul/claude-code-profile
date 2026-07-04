import { gzipSync, gunzipSync } from 'node:zlib'

export interface Bundle { v: 1; manifestYaml: string; assets: Record<string, string> }

export function exportBundle(manifestYaml: string, assets: Record<string, string>): Buffer {
  return gzipSync(JSON.stringify({ v: 1, manifestYaml, assets } satisfies Bundle))
}

export function importBundle(buf: Buffer): Bundle {
  let parsed: any
  try {
    parsed = JSON.parse(gunzipSync(buf).toString('utf8'))
  } catch {
    throw new Error('not a ccprofiles bundle (expected a file created by: ccp export)')
  }
  if (parsed?.v !== 1 || typeof parsed.manifestYaml !== 'string') throw new Error('not a ccprofiles bundle (expected a file created by: ccp export)')
  return parsed as Bundle
}
