import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// The pay portal is a Node server only (no Workers build): `pnpm build` (or
// `build:node`) writes dist/, `node node/server.mjs` serves it. Every
// dependency is bundled into dist/server, so the image needs no node_modules
// (distroless, like the storefront renderer and forms-portal's Node build).
export default defineConfig({
  server: {
    port: 3033,
  },
  resolve: {
    alias: [{ find: '@', replacement: here('.') }],
  },
  environments: { ssr: { resolve: { noExternal: true } } },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
