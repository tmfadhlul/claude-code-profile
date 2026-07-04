import { cp, rm, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'packages/ui/dist')
const dest = join(root, 'packages/cli/dist/ui')
try { await access(src) } catch { console.error('packages/ui/dist missing — run vite build first'); process.exit(1) }
await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
console.log(`copied UI → ${dest}`)
