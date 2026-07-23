import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/welddrive',
  '/welddrive/all-files',
  '/welddrive/recent',
  '/welddrive/shared',
  '/welddrive/starred',
  '/welddrive/trash',
  '/welddrive/uploads',
];

test.describe('WeldDrive · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
