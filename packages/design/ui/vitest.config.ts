import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    // The library imports itself by name (`@weldsuite/ui/components/button`); its exports map those to src/.
    alias: [{ find: /^@weldsuite\/ui\/(components|lib|hooks|providers)\/(.*)$/, replacement: `${src}/$1/$2` }],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
    },
  },
});
