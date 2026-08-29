import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3200,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 3200,
  },
  envPrefix: 'VITE_',
});
