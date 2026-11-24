import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { build, loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defaultServerFrom } from './src/lib/build-config';
import { buildManifest, ICON_SIZES } from './src/manifest/manifest';
import en from './src/locales/en.json';
import nl from './src/locales/nl.json';

const root = __dirname;
/** The Playwright run builds into its own folder, so it never clobbers `dist/`. */
const outDir = process.env.WELDPASS_OUT_DIR || 'dist';
const alias = { '@': path.resolve(root, './src') };

/**
 * Emits `manifest.json` and Chrome's `_locales/`, then builds the content
 * script. Content scripts can't be ES modules, so it is its own IIFE build
 * into the same `dist/` (`content.js`), after the pages and the worker.
 */
function extensionFiles(mode: string, env: Record<string, string>): Plugin {
  return {
    name: 'weldpass-extension-files',
    generateBundle() {
      const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      const hasIcons = ICON_SIZES.every((size) =>
        existsSync(path.join(root, 'public', 'icons', `icon-${size}.png`)),
      );
      const manifest = buildManifest({
        version,
        defaultServer: defaultServerFrom(env),
        store: mode === 'store',
        extensionKey: env.VITE_EXTENSION_KEY,
        hasIcons,
      });
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
    async closeBundle() {
      await build({
        configFile: false,
        root,
        mode,
        logLevel: 'warn',
        envPrefix: 'VITE_',
        resolve: { alias },
        define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production') },
        build: {
          outDir,
          emptyOutDir: false,
          target: 'chrome116',
          minify: mode !== 'development',
          sourcemap: false,
          lib: {
            entry: path.resolve(root, 'src/content/index.ts'),
            formats: ['iife'],
            name: 'weldpassContent',
            fileName: () => 'content.js',
          },
          rollupOptions: { output: { extend: true } },
        },
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');

  return {
    // Relative asset URLs: pages are served from chrome-extension://<id>/.
    base: './',
    plugins: [react(), tailwindcss(), extensionFiles(mode, env)],
    resolve: { alias },
    envPrefix: 'VITE_',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'chrome116',
      // Extension pages may not run inline scripts, so no preload polyfill.
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          popup: path.resolve(root, 'popup.html'),
          settings: path.resolve(root, 'settings.html'),
          menu: path.resolve(root, 'menu.html'),
          prompt: path.resolve(root, 'prompt.html'),
          background: path.resolve(root, 'src/background/index.ts'),
        },
        output: {
          // The manifest names the worker by a fixed path.
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: ['e2e/**', 'node_modules/**'],
    },
  };
});
