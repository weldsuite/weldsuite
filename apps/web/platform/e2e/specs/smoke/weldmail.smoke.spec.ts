/**
 * Comprehensive smoke spec for WeldMail — every authenticated route
 * in the module.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldmail',
  '/weldmail/ai/smart-reply',
  '/weldmail/ai/summary',
  '/weldmail/domains',
  '/weldmail/inbox',
  '/weldmail/inbox/compose',
  '/weldmail/scheduled',
  '/weldmail/search',
  '/weldmail/settings/accounts',
  '/weldmail/settings/labels',
  '/weldmail/setup',
  '/weldmail/snoozed',
];

test.describe('WeldMail · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
