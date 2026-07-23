/**
 * Comprehensive smoke spec for the global Settings module — every
 * sub-page is verified to load and render the auth shell.
 */

import { test } from '../../fixtures';
import { smokeRoute, type SmokeRoute } from '../../helpers/smoke';

const routes: SmokeRoute[] = [
  { path: '/settings' },
  { path: '/settings/activity' },
  { path: '/settings/advanced' },
  { path: '/settings/api-keys' },
  { path: '/settings/appearance' },
  { path: '/settings/apps/phone-numbers' },
  { path: '/settings/apps/phone-numbers/new-number' },
  { path: '/settings/apps/phone-numbers/port' },
  { path: '/settings/apps/weldcrm' },
  { path: '/settings/apps/welddesk' },
  { path: '/settings/apps/weldmail' },
  { path: '/settings/apps/weldsuite' },
  { path: '/settings/billing' },
  { path: '/settings/business' },
  { path: '/settings/custom-fields' },
  // Desktop settings is Electron-only; in a browser the page redirects
  // back to /settings (see app/settings/desktop/page.tsx).
  { path: '/settings/desktop', expectedUrl: /\/settings$/ },
  { path: '/settings/export' },
  { path: '/settings/feedback' },
  { path: '/settings/general' },
  { path: '/settings/integrations' },
  { path: '/settings/integrations/attio' },
  { path: '/settings/integrations/crm-sync' },
  { path: '/settings/integrations/discord' },
  { path: '/settings/integrations/github' },
  { path: '/settings/integrations/google-calendar' },
  { path: '/settings/integrations/hubspot' },
  { path: '/settings/integrations/mcp-servers' },
  { path: '/settings/integrations/salesforce' },
  { path: '/settings/integrations/slack' },
  { path: '/settings/notifications' },
  { path: '/settings/object-templates' },
  { path: '/settings/plans' },
  { path: '/settings/privacy' },
  { path: '/settings/roles' },
  { path: '/settings/security' },
  { path: '/settings/shortcuts' },
  { path: '/settings/team' },
];

test.describe('Settings · smoke', () => {
  for (const route of routes) {
    test(`${route.path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, route);
    });
  }
});
