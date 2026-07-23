import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldchat',
  '/weldchat/activity',
  '/weldchat/bookmarks',
  '/weldchat/directories',
  '/weldchat/dm',
  '/weldchat/drafts',
  '/weldchat/search',
];

test.describe('WeldChat · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
