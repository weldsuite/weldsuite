import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The admin console: TanStack Start on a Cloudflare Worker (ADR FE-018).
 * Routes are thin files in `src/routes/`; the pages' views, loaders and
 * server functions live in `app/` (the platform's convention).
 */
export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  plugins: [
    tailwindcss(),
    // The Start server runs in the Workers runtime, in dev as well as deployed.
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart({
      // Database drivers and server-only modules must never reach the browser:
      // fail the build instead of shipping a stub.
      importProtection: {
        behavior: 'error',
        client: { specifiers: ['@neondatabase/serverless', 'postgres', '@clerk/backend'] },
      },
    }),
    viteReact(),
  ],
});
