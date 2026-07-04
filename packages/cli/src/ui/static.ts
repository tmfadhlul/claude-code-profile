import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import type { ServerResponse } from 'node:http'

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
}

export function serveStatic(res: ServerResponse, urlPath: string, uiDir: string): void {
  const index = join(uiDir, 'index.html')
  // strip query, prevent path traversal
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let file = join(uiDir, clean)
  if (!file.startsWith(uiDir) || !existsSync(file) || statSync(file).isDirectory()) file = index
  if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('UI not built'); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}
