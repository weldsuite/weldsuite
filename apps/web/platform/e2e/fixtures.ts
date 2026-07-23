import { test as base, expect } from '@playwright/test';
import { testFixtures } from './helpers/test-fixtures-client';
import { watchConsoleErrors } from './helpers/console-errors';

interface E2EFixtures {
  /** Client for /test-fixtures/* — seed entities, reset, ping. */
  api: typeof testFixtures;
  /**
   * Console-error watcher. Auto-applied to every test: if the page emits
   * any unexpected `console.error` or `pageerror`, the test fails at
   * teardown. Tests that legitimately expect errors can read
   * `consoleErrors.errors` and clear them before the test ends.
   */
  consoleErrors: ReturnType<typeof watchConsoleErrors>;
}

export const test = base.extend<E2EFixtures>({
  api: async ({}, use) => {
    await use(testFixtures);
  },

  consoleErrors: [
    async ({ page }, use) => {
      const watcher = watchConsoleErrors(page);
      await use(watcher);
      watcher.assertNone();
    },
    { auto: true },
  ],
});

export { expect };
