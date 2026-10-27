import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://shop.example.com/' } },
    include: ['src/**/*.test.ts'],
  },
});
