import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base — the bundle is served from a per-app path inside WeldSuite.
  base: './',
  plugins: [react()],
});
