import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { formsEmbed } from './vite-plugins/forms-embed'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Two builds of the same app (like sign-portal, ADR FE-017):
// - the Cloudflare Worker (Global): `pnpm build`, the default;
// - a Node server for the Kubernetes editions: `pnpm build:node` (`--mode node`).
//   It runs `node node/server.mjs`, reaches the backend over HTTP and bundles
//   every dependency, so the image needs no node_modules.
export default defineConfig(({ mode }) => {
  const node = mode === 'node'
  return {
    server: {
      port: 3025,
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
      // /embed.js: the SDK, bundled from packages/sdk/forms-embed into a string.
      formsEmbed(),
      // The Start server runs in the Workers runtime, in dev as well as deployed.
      ...(node ? [] : [cloudflare({ viteEnvironment: { name: 'ssr' } })]),
      tanstackStart(),
      viteReact(),
    ],
  }
})
