/**
 * Smoke spec for WeldDesk v1 — inbox + chat widget only.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/welddesk',
  '/welddesk/inbox',
  '/welddesk/chat-widget',
];

test.describe('WeldDesk · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
