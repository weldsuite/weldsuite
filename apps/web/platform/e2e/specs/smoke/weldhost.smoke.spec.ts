import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldhost',
  '/weldhost/domains',
  '/weldhost/domains/purchase/cancel',
  '/weldhost/domains/purchase/success',
  '/weldhost/domains/register',
  '/weldhost/domains/search',
];

test.describe('WeldHost · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
