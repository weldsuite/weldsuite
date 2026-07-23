/**
 * Comprehensive smoke spec for WeldCRM — every authenticated route
 * in the module.
 */

import { test } from '../../fixtures';
import { smokeRoute, type SmokeRoute } from '../../helpers/smoke';

const routes: SmokeRoute[] = [
  { path: '/weldcrm' },
  { path: '/weldcrm/companies' },
  { path: '/weldcrm/companies/lists' },
  { path: '/weldcrm/notes' },
  { path: '/weldcrm/people' },
  { path: '/weldcrm/sequences' },
];

test.describe('WeldCRM · smoke', () => {
  for (const route of routes) {
    test(`${route.path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, route);
    });
  }
});
