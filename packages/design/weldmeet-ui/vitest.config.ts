import { defineConfig } from 'vitest/config';

// Unit tests (`*.test.ts` under src). The component tests are Playwright's
// (`ct/`, `pnpm test:ct`).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
