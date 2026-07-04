import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // tests always run against source, not stale dist builds
      '@ccprofiles/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'] },
})
