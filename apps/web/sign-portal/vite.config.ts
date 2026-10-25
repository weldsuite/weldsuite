import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: {
    port: 3023,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  plugins: [
    tailwindcss(),
    // The Start server runs in the Workers runtime, in dev as well as deployed.
    // Local dev shares `pnpm dev:api`'s simulated KV, R2 and D1 (it runs from
    // apps/workers/app-api), so a link sign-api created there opens here.
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: { path: fileURLToPath(new URL('../../workers/app-api/.wrangler/state', import.meta.url)) },
    }),
    tanstackStart(),
    viteReact(),
  ],
})
