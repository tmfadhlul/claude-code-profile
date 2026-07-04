import { randomBytes, timingSafeEqual } from 'node:crypto'

export function newUiToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided), b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export function originOk(origin: string | undefined, port: number): boolean {
  if (!origin) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}
