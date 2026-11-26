import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The shell's own pages (server/, offline/) carry a strict Content Security
 * Policy for the built app. Vite's dev server injects styles inline and talks
 * to the page over a WebSocket, so under `pnpm dev` only, the policy allows
 * both; builds keep it as written.
 */
function relaxCspForDevServer(): Plugin {
  return {
    name: 'weldsuite-desktop:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace("img-src 'self' data:", "img-src 'self' data:; connect-src 'self' ws://localhost:*");
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'es', entryFileNames: 'index.mjs' },
        external: ['electron', 'electron-updater'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          titlebar: resolve(__dirname, 'src/preload/titlebar.ts'),
          server: resolve(__dirname, 'src/preload/server.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [relaxCspForDevServer()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          titlebar: resolve(__dirname, 'src/renderer/titlebar/index.html'),
          server: resolve(__dirname, 'src/renderer/server/index.html'),
          offline: resolve(__dirname, 'src/renderer/offline/index.html'),
        },
      },
    },
  },
});
