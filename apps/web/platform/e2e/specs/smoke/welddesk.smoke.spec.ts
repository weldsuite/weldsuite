/**
 * Smoke spec for WeldDesk v1 — inbox, saved replies and the WeldDesk settings.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/welddesk',
  '/welddesk/inbox',
  '/welddesk/saved-replies',
  '/settings/apps/welddesk',
  '/settings/apps/welddesk/chat-widget',
];

test.describe('WeldDesk · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
