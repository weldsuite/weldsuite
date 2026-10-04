import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildManifest, ICON_SIZES, type ManifestEnv } from './src/manifest/manifest';
import en from './src/locales/en.json';
import nl from './src/locales/nl.json';

const root = __dirname;

/**
 * Emits `manifest.json` and Chrome's `_locales/` into the bundle. The manifest
 * depends on the env (see src/manifest/manifest.ts); the locale files live in
 * src/ so the popup can type its message keys against them.
 */
function extensionFiles(env: ManifestEnv): Plugin {
  return {
    name: 'weldpass-extension-files',
    generateBundle() {
      const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      const hasIcons = ICON_SIZES.every((size) =>
        existsSync(path.join(root, 'public', 'icons', `icon-${size}.png`)),
      );
      const manifest = buildManifest({ version, env, hasIcons });

      if (manifest.host_permissions.length === 0) {
        this.warn(
          'VITE_API_URL / VITE_SYNC_HOST / VITE_CLERK_PUBLISHABLE_KEY are not set: ' +
            'the manifest has no host permissions and the popup will show "not configured".',
        );
      }

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
      for (const [locale, messages] of Object.entries({ en, nl })) {
        this.emitFile({
          type: 'asset',
          fileName: `_locales/${locale}/messages.json`,
          source: `${JSON.stringify(messages, null, 2)}\n`,
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');

  return {
    // Relative asset URLs: the popup is served from chrome-extension://<id>/.
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      extensionFiles({
        publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
        syncHost: env.VITE_SYNC_HOST,
        apiUrl: env.VITE_API_URL,
        extensionKey: env.VITE_EXTENSION_KEY,
      }),
    ],
    resolve: {
      alias: { '@': path.resolve(root, './src') },
    },
    envPrefix: 'VITE_',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'chrome116',
      // Extension pages may not run inline scripts, so no preload polyfill.
      modulePreload: { polyfill: false },
      // Clerk's SDK (clerk-js plus its bundled UI, no remotely hosted code) is
      // ~1.4 MB of the popup chunk. It loads from disk, not the network.
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        input: { popup: path.resolve(root, 'popup.html') },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
