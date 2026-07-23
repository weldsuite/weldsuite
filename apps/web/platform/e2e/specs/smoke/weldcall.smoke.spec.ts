import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldcall',
  '/weldcall/contacts',
  '/weldcall/history',
  '/weldcall/new',
];

test.describe('WeldCall · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
