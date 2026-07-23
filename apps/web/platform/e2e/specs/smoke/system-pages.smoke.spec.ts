/**
 * Smoke spec for cross-cutting system pages — home, appstore, agents,
 * and checkout return URLs.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/',
  '/agents',
  '/appstore',
];

test.describe('System pages · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
