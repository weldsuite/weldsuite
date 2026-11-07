import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The modules the Node build swaps for their `.node` sibling: what Global's
 * Worker takes from Cloudflare, Neon and Clerk, the Node server takes from
 * Postgres over TCP, an SMTP relay and (later) the install's Zitadel.
 */
const NODE_MODULES = [
  'lib/server/database',
  'lib/server/identity',
  'lib/server/email-transport',
  'lib/auth-middleware',
  'lib/auth-client',
];
const NODE_EXTENSION: Record<string, string> = { 'lib/auth-client': 'tsx' };

/**
 * The admin console, two builds of one app (ADR FE-018):
 * - the Cloudflare Worker for Global: `pnpm build`, the default;
 * - a Node server for the Kubernetes editions (EU, self-hosted):
 *   `pnpm build:node` (`--mode node`). It runs `node node/server.mjs` in the
 *   console's container, has none of Global's pages (`lib/edition.ts`) and
 *   bundles every dependency, so the image needs no node_modules.
 *
 * Routes are thin files in `src/routes/`; the pages' views, loaders and
 * server functions live in `app/` (the platform's convention).
 */
export default defineConfig(({ mode }) => {
  const node = mode === 'node';
  return {
    server: {
      port: 3001,
    },
    resolve: {
      alias: [
        ...(node
          ? NODE_MODULES.map((path) => ({
              find: new RegExp(`^@/${path}$`),
              replacement: here(`./${path}.node.${NODE_EXTENSION[path] ?? 'ts'}`),
            }))
          : []),
        { find: '@', replacement: here('.') },
      ],
    },
    ...(node ? { environments: { ssr: { resolve: { noExternal: true } } } } : {}),
    plugins: [
      tailwindcss(),
      // The Worker's server runs in the Workers runtime, in dev as well as deployed.
      ...(node ? [] : [cloudflare({ viteEnvironment: { name: 'ssr' } })]),
      tanstackStart({
        // Database drivers and server-only modules must never reach the browser:
        // fail the build instead of shipping a stub.
        importProtection: {
          behavior: 'error',
          client: { specifiers: ['@neondatabase/serverless', 'postgres', '@clerk/backend', 'nodemailer'] },
        },
      }),
      viteReact(),
    ],
  };
});
