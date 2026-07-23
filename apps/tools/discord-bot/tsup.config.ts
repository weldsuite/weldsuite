import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  noExternal: [/^@workspace\//],
  splitting: false,
  clean: true,
});
