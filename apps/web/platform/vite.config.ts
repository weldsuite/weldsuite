import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'node:path';

function i18nChunkName(normalizedId: string): string | undefined {
  const i18nMatch = normalizedId.match(/\/packages\/i18n\/src\/locales\/(en|nl|fr)\/([^/]+)\.ts/);
  if (!i18nMatch) return undefined;
  const [, locale, ns] = i18nMatch;
  return ns === 'index' ? undefined : `i18n-${locale}-${ns}`;
}

// Vendor chunk assignment by package name: exact matches first, then prefixes.
const VENDOR_CHUNKS_EXACT = new Map<string, string>([
  ['react', 'react-vendor'],
  ['react-dom', 'react-vendor'],
  ['scheduler', 'react-vendor'],
  ['@tanstack/react-query', 'tanstack-query'],
  ['@tanstack/query-core', 'tanstack-query'],
  ['@tanstack/react-router', 'tanstack-router'],
  ['@tanstack/router-core', 'tanstack-router'],
  ['@tanstack/router-devtools', 'tanstack-router'],
  // Collapse lucide-react's icons into ONE chunk. Each icon is a tiny
  // module; left to default chunking, icons shared across lazy routes
  // get extracted as hundreds of ~1-2 KB facade chunks (webhook-*.js,
  // list-todo-*.js, …). That many micro-chunks is both wasteful and a
  // reliability hazard on resource-constrained CI builders — a build
  // killed mid-write drops some of them, leaving the entry's mapDeps
  // pointing at files that were never emitted (white-screen on load).
  ['lucide-react', 'lucide-vendor'],
  ['recharts', 'charts-vendor'],
  ['zod', 'zod-vendor'],
  ['date-fns', 'date-fns-vendor'],
  ['react-hook-form', 'react-hook-form-vendor'],
  ['react-day-picker', 'react-day-picker-vendor'],
  ['micromark', 'markdown-vendor'],
  ['unified', 'markdown-vendor'],
  ['remark', 'markdown-vendor'],
  ['tailwind-merge', 'styles-vendor'],
  ['clsx', 'styles-vendor'],
  ['class-variance-authority', 'styles-vendor'],
]);

const VENDOR_CHUNKS_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['@clerk/', 'clerk-vendor'],
  ['d3-', 'charts-vendor'],
  ['@radix-ui/', 'radix-vendor'],
  ['@dnd-kit/', 'dnd-kit-vendor'],
  ['micromark-', 'markdown-vendor'],
  ['mdast-', 'markdown-vendor'],
  ['remark-', 'markdown-vendor'],
];

function vendorChunkName(pkg: string): string | undefined {
  const exact = VENDOR_CHUNKS_EXACT.get(pkg);
  if (exact) return exact;
  return VENDOR_CHUNKS_PREFIX.find(([prefix]) => pkg.startsWith(prefix))?.[1];
}

export default defineConfig(async () => {
  const { visualizer } = await import('rollup-plugin-visualizer');
  return {
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    visualizer({
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
      template: 'treemap',
    }) as any,
  ],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Pin Rollup's CJS interop helpers into react-vendor. Without this,
          // Rollup hoists the helper into whatever consumer chunk it picks
          // (charts-vendor, clerk-vendor, …), and react-vendor then imports
          // back from that chunk — a circular chunk dep. When the consumer
          // evaluates first it calls into half-initialised React (var X is
          // hoisted but still undefined), crashing at module init with
          // "Cannot set properties of undefined (setting 'Children')".
          if (id.includes('commonjsHelpers') || id.includes('\x00commonjs')) return 'react-vendor';

          const norm = id.replace(/\\/g, '/');

          // i18n namespaces: split per `<locale>/<namespace>` so no single
          // locale chunk is over ~150 KB. Provider eagerly loads the active
          // locale's namespaces in parallel — total bytes unchanged, but each
          // chunk file is small.
          const i18nChunk = i18nChunkName(norm);
          if (i18nChunk) return i18nChunk;

          if (!norm.includes('/node_modules/')) return undefined;
          const m = norm.match(/\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)/);
          if (!m) return undefined;
          return vendorChunkName(m[1]);
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Vite's dep pre-bundler defaults to `sourcemap: true`, which writes a
      // `.map` next to every chunk in node_modules/.vite/deps — here that's
      // ~3400 files totalling ~54 MB (one chunk alone is 9.5 MB), roughly
      // double the JS it maps.
      //
      // With Chrome DevTools CLOSED nothing ever requests them, so the app
      // feels fine. Open DevTools and the browser fetches the map for every
      // loaded dep chunk — a few MB on the sign-in page, tens of MB once the
      // full app is up — and pays that cost twice: Chrome parses and retains
      // each map, and Vite's dev server reads, JSON.parses, rewrites the
      // ignore list and JSON.stringifies each one PER REQUEST with no cache
      // (the isSourceMap branch of its transform middleware). The Node process
      // chewing through 9.5 MB JSON documents is what stalls HMR and every
      // subsequent module request, so the whole app crawls.
      //
      // Dropping these maps only affects third-party code — our own sources
      // keep their inline maps and still resolve to real .ts/.tsx in DevTools.
      // Set VITE_DEP_SOURCEMAPS=true to get them back for a session where you
      // genuinely need to step inside a dependency (delete node_modules/.vite
      // afterwards to force a re-bundle).
      sourcemap: process.env.VITE_DEP_SOURCEMAPS === 'true',
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
    // Packages that keep module-level state and must exist once in the bundle.
    //
    // The workspace installs with `node-linker=hoisted`, and the root slot for
    // `sonner` is taken by the 1.x the portals use. The platform,
    // `@weldsuite/ui` and `@weldsuite/weldmeet-ui` therefore each get their own
    // nested copy of sonner 2.x, each with its own toast store. The `<Toaster>`
    // (mounted from `@weldsuite/ui`) listens to one of them, so a `toast()`
    // called from platform or weldmeet-ui code landed in a store nobody
    // rendered. Deduping resolves every import to the platform's copy.
    // Keep in sync with vitest.config.ts (components/toaster.test.tsx covers it).
    dedupe: ['sonner'],
  },
  envPrefix: 'VITE_',
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/mp/lib.min.js': { target: 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js', changeOrigin: true, rewrite: () => '' },
      '/mp/lib.js': { target: 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.js', changeOrigin: true, rewrite: () => '' },
      '/mp/decide': { target: 'https://decide.mixpanel.com', changeOrigin: true, rewrite: (p: string) => p.replace('/mp', '') },
      '/mp': { target: 'https://api-eu.mixpanel.com', changeOrigin: true, rewrite: (p: string) => p.replace('/mp', '') },
    },
  },
  };
});