import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: the Cloudflare and Start plugins are not wanted in unit tests.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { environment: 'node', include: ['lib/**/*.test.ts'] },
})
