import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests only: the app's own build (vite.config.ts) brings the Workers
// runtime and TanStack Start, which tests don't need.
export default defineConfig({
  resolve: {
    alias: [{ find: '@', replacement: fileURLToPath(new URL('./', import.meta.url)) }],
  },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', '.wrangler/**'],
  },
})
