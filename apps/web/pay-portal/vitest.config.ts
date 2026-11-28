import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: the Start plugin is not wanted in unit tests.
export default defineConfig({
  resolve: { alias: [{ find: '@', replacement: fileURLToPath(new URL('./', import.meta.url)) }] },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
