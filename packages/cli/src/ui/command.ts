import type { Command } from 'commander'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { CliContext } from '../context.js'
import { startUiServer } from './server.js'
import { newUiToken } from './token.js'

function defaultUiDir(): string {
  // command.ts compiles to dist/ui/command.js; built assets are copied to dist/ui/
  const here = dirname(fileURLToPath(import.meta.url)) // .../dist/ui
  return join(dirname(here), 'ui')                     // .../dist/ui
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref() } catch { /* non-fatal */ }
}

export function registerUiCommand(program: Command, ctx: CliContext): void {
  program.command('ui').description('open the web dashboard (localhost)')
    .option('--port <n>', 'port (default: random)', v => parseInt(v, 10))
    .option('--no-open', 'do not open the browser automatically')
    .action(async (opts: { port?: number; open?: boolean }) => {
      const uiDir = ctx.env.CCPROFILES_UI_DIR ?? defaultUiDir()
      if (!existsSync(join(uiDir, 'index.html'))) {
        console.log(`dashboard assets not found at ${uiDir} — build first: npm run build`)
        return
      }
      const token = newUiToken()
      const srv = await startUiServer(ctx, { port: opts.port, token, uiDir })
      const url = `http://127.0.0.1:${srv.port}/?t=${token}`
      console.log(`ccprofiles dashboard: ${url}`)
      console.log('(localhost only · Ctrl-C to stop)')
      if (opts.open !== false) openBrowser(url)
      // test hooks: let tests observe the server and close it
      ;(globalThis as any).__uiServerClose = srv.close
      ;(globalThis as any).__uiOnListening?.()
      if (!ctx.env.CCPROFILES_UI_DIR) await new Promise(() => {}) // run until Ctrl-C in real use
    })
}
