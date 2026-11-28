import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// A Node server for the portal's container on Kubernetes (ADR FE-017).
// `pnpm build` (or `build:node`, which the image runs) writes it to dist/ with every dependency bundled, so the image
// needs no node_modules; `node node/server.mjs` serves it. The server routes
// call the Rust backend (lib/server/signer-portal.ts).
export default defineConfig({
  server: {
    port: 3023,
  },
  resolve: {
    alias: [{ find: '@', replacement: here('.') }],
  },
  environments: { ssr: { resolve: { noExternal: true } } },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
