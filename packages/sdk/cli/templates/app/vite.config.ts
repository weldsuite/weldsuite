import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const FRAME_ANCESTORS = [
  "'self'",
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://app-test.weldsuite.org',
  'https://app.weldsuite.org',
].join(' ');

export default defineConfig({
  // Relative base — the bundle is served from a per-app path inside WeldSuite.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    headers: {
      'Content-Security-Policy': `frame-ancestors ${FRAME_ANCESTORS}`,
    },
  },
});
