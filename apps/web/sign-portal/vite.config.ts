import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Two builds of the same app:
// - the Cloudflare Worker (Global, ADR FE-016): `pnpm build`, the default;
// - a Node server for the Kubernetes editions (ADR FE-017): `pnpm build:node`
//   (`--mode node`). It runs `node node/server.mjs` in the portal's container,
//   calls the backend instead of the signing domain (lib/server/runtime.node.ts)
//   and bundles every dependency, so the image needs no node_modules.
export default defineConfig(({ mode }) => {
  const node = mode === 'node'
  return {
    server: {
      port: 3023,
    },
    resolve: {
      alias: [
        ...(node ? [{ find: /^@\/lib\/server\/runtime$/, replacement: here('./lib/server/runtime.node.ts') }] : []),
        { find: '@', replacement: here('.') },
      ],
    },
    ...(node ? { environments: { ssr: { resolve: { noExternal: true } } } } : {}),
    plugins: [
      tailwindcss(),
      // The Start server runs in the Workers runtime, in dev as well as deployed.
      // Local dev shares `pnpm dev:api`'s simulated KV, R2 and D1 (it runs from
      // apps/workers/app-api), so a link sign-api created there opens here.
      ...(node
        ? []
        : [
            cloudflare({
              viteEnvironment: { name: 'ssr' },
              persistState: { path: here('../../workers/app-api/.wrangler/state') },
            }),
          ]),
      tanstackStart(),
      viteReact(),
    ],
  }
})
