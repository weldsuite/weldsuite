/**
 * Comprehensive smoke spec for WeldDesk — every authenticated route
 * in the module.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/welddesk',
  '/welddesk/ai-active',
  '/welddesk/ai-resolved',
  '/welddesk/analytics',
  '/welddesk/analytics/builder',
  '/welddesk/announcements',
  '/welddesk/announcements/new',
  '/welddesk/automations',
  '/welddesk/changelog',
  '/welddesk/chat-widget',
  '/welddesk/contacts',
  '/welddesk/contacts/new',
  '/welddesk/help',
  '/welddesk/help/new',
  '/welddesk/helpcenter',
  '/welddesk/inbox/all',
  '/welddesk/inbox/archived',
  '/welddesk/inbox/chat',
  '/welddesk/inbox/discord',
  '/welddesk/inbox/email',
  '/welddesk/inbox/slack',
  '/welddesk/knowledge',
  '/welddesk/knowledge/new',
  '/welddesk/news',
  '/welddesk/news/new',
  '/welddesk/reviews',
  '/welddesk/settings',
  '/welddesk/settings/integrations/discord',
  '/welddesk/settings/integrations/email',
  '/welddesk/settings/integrations/slack',
  '/welddesk/settings/saved-replies',
  '/welddesk/settings/ticket-types',
  '/welddesk/settings/tickets',
  '/welddesk/teams',
  '/welddesk/teams/new',
  '/welddesk/teams/support',
  '/welddesk/tickets',
  '/welddesk/tickets/new',
  '/welddesk/weldagent',
  '/welddesk/workflows',
];

test.describe('WeldDesk · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
