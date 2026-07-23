import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

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
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          titlebar: resolve(__dirname, 'src/renderer/titlebar/index.html'),
        },
      },
    },
  },
});
