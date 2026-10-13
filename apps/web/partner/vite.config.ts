import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // One sonner instance for the <Toaster /> and every toast() call.
    dedupe: ['sonner'],
  },
  server: {
    port: 3203,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 3203,
  },
  envPrefix: 'VITE_',
});
