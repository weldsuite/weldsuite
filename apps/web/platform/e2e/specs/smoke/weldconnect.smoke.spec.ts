import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldconnect',
  '/weldconnect/actions',
  '/weldconnect/analytics',
  '/weldconnect/executions',
  '/weldconnect/templates',
  '/weldconnect/triggers',
  '/weldconnect/variables',
  '/weldconnect/webhooks',
  '/weldconnect/workflows',
];

test.describe('WeldConnect · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
