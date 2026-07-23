import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldmeet',
  '/weldmeet/history',
  '/weldmeet/new',
  '/weldmeet/people',
  '/weldmeet/upcoming',
];

test.describe('WeldMeet · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
