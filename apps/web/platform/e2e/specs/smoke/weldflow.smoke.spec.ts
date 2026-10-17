/**
 * Comprehensive smoke spec for WeldFlow — every authenticated route
 * in the module.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldflow',
  '/weldflow/analytics',
  '/weldflow/analytics/builder',
  '/weldflow/files',
  '/weldflow/goals',
  '/weldflow/my-tasks',
  '/weldflow/projects',
  '/weldflow/whiteboard',
  '/weldflow/workload',
];

test.describe('WeldFlow · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
