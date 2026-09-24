import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Absolute, forward-slash globs for coverage: with `allowExternal` a relative
// pattern no longer matches, and a backslash is an escape inside a glob.
const glob = (dir: string) => path.resolve(__dirname, dir).replace(/\\/g, '/');
const APP_SRC = glob('src');
const PERMISSIONS_SRC = glob('../../../packages/core/permissions/src');

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard).
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    // Coverage feeds SonarQube Cloud (see sonar-project.properties). lcov is the
    // format the Sonar scanner reads; text keeps the local run readable.
    //
    // @weldsuite/permissions has no test runner of its own: its checks are
    // exercised here (src/routes/_app-permissions.test.ts), so its source is
    // included too. lcov paths are written relative to the repo root
    // (`apps/workers/app-api/src/…`, `packages/core/permissions/src/…`), the
    // form Sonar resolves directly against its base directory.
    coverage: {
      provider: 'v8',
      reporter: ['text', ['lcov', { projectRoot: path.resolve(__dirname, '../../..') }]],
      reportsDirectory: './coverage',
      allowExternal: true,
      include: [`${APP_SRC}/**/*.ts`, `${PERMISSIONS_SRC}/**/*.{ts,tsx}`],
      exclude: [`${APP_SRC}/**/*.test.ts`, `${APP_SRC}/test/**`, `${PERMISSIONS_SRC}/**/*.test.{ts,tsx}`],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `cloudflare:email` is a Workers-runtime module with no node resolution;
      // point it at a test stub so route modules that import it can load.
      'cloudflare:email': path.resolve(__dirname, './src/test/stubs/cloudflare-email.ts'),
    },
  },
});
