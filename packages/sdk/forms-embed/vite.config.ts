import { defineConfig } from 'vite';

// One self-contained IIFE: dist/embed.js, exposing window.WeldForms and
// auto-initialising `[data-wf]` elements. forms-portal serves the same bundle
// at /embed.js (see apps/web/forms-portal/vite-plugins/forms-embed.ts).
export default defineConfig({
  build: {
    lib: {
      entry: 'src/embed-entry.ts',
      formats: ['iife'],
      name: 'WeldForms',
      fileName: () => 'embed.js',
    },
    target: 'es2019',
    minify: true,
    emptyOutDir: true,
  },
});
