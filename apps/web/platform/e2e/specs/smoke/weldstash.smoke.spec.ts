import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldstash',
  '/weldstash/products',
  '/weldstash/stock',
  '/weldstash/suppliers',
  '/weldstash/warehouses',
];

test.describe('WeldStash · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
