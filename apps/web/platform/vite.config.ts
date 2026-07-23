import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'path';

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
        manualChunks(id) {
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
          const i18nMatch = norm.match(/\/packages\/i18n\/src\/locales\/(en|nl|fr)\/([^/]+)\.ts/);
          if (i18nMatch) {
            const [, locale, ns] = i18nMatch;
            if (ns !== 'index') return `i18n-${locale}-${ns}`;
          }

          if (!norm.includes('/node_modules/')) return undefined;
          const m = norm.match(/\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)/);
          if (!m) return undefined;
          const pkg = m[1];
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react-vendor';
          if (pkg.startsWith('@clerk/')) return 'clerk-vendor';
          if (pkg === '@tanstack/react-query' || pkg === '@tanstack/query-core') return 'tanstack-query';
          if (pkg === '@tanstack/react-router' || pkg === '@tanstack/router-core' || pkg === '@tanstack/router-devtools') return 'tanstack-router';
          // Collapse lucide-react's icons into ONE chunk. Each icon is a tiny
          // module; left to default chunking, icons shared across lazy routes
          // get extracted as hundreds of ~1-2 KB facade chunks (webhook-*.js,
          // list-todo-*.js, …). That many micro-chunks is both wasteful and a
          // reliability hazard on resource-constrained CI builders — a build
          // killed mid-write drops some of them, leaving the entry's mapDeps
          // pointing at files that were never emitted (white-screen on load).
          if (pkg === 'lucide-react') return 'lucide-vendor';
          if (pkg === 'recharts' || pkg.startsWith('d3-')) return 'charts-vendor';
          if (pkg === 'zod') return 'zod-vendor';
          if (pkg === 'date-fns') return 'date-fns-vendor';
          if (pkg.startsWith('@radix-ui/')) return 'radix-vendor';
          if (pkg === 'react-hook-form') return 'react-hook-form-vendor';
          if (pkg === 'react-day-picker') return 'react-day-picker-vendor';
          if (pkg.startsWith('@dnd-kit/')) return 'dnd-kit-vendor';
          if (pkg === 'micromark' || pkg.startsWith('micromark-') || pkg.startsWith('mdast-') || pkg === 'unified' || pkg === 'remark' || pkg.startsWith('remark-')) return 'markdown-vendor';
          if (pkg === 'tailwind-merge' || pkg === 'clsx' || pkg === 'class-variance-authority') return 'styles-vendor';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  envPrefix: 'VITE_',
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/mp/lib.min.js': { target: 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js', changeOrigin: true, rewrite: () => '' },
      '/mp/lib.js': { target: 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.js', changeOrigin: true, rewrite: () => '' },
      '/mp/decide': { target: 'https://decide.mixpanel.com', changeOrigin: true, rewrite: (p) => p.replace('/mp', '') },
      '/mp': { target: 'https://api-eu.mixpanel.com', changeOrigin: true, rewrite: (p) => p.replace('/mp', '') },
    },
  },
  };
});