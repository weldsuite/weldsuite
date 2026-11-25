import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The unit tests, apart from the extension build in vite.config.ts (whose
// plugins emit the manifest and build the content script). Each test file
// picks jsdom with `@vitest-environment jsdom` when it needs a DOM.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
