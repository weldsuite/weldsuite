import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The admin console (ADR FE-018): a Node server for its container on
 * Kubernetes. `pnpm build` writes dist/, which `node node/server.mjs` serves.
 *
 * Routes are thin files in `src/routes/`; the pages' views, loaders and
 * server functions live in `app/` (the platform's convention).
 */
export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    alias: [{ find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) }],
  },
  // Every dependency is bundled into the server build, so the image needs no node_modules.
  environments: { ssr: { resolve: { noExternal: true } } },
  plugins: [
    tailwindcss(),
    tanstackStart({
      // Database drivers and server-only modules must never reach the browser:
      // fail the build instead of shipping a stub.
      importProtection: {
        behavior: 'error',
        client: { specifiers: ['postgres', 'nodemailer'] },
      },
    }),
    viteReact(),
  ],
});
