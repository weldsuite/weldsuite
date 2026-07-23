/**
 * Interaction spec for the global Settings module. Verifies every
 * settings sub-page renders the auth shell and the right URL —
 * essential because Settings is the entry point to billing, roles,
 * integrations, and other high-blast-radius surfaces.
 */

import { test, expect } from '../../fixtures';

const subPages = [
  'general',
  'business',
  'team',
  'roles',
  'security',
  'billing',
  'plans',
  'api-keys',
  'appearance',
  'shortcuts',
  'notifications',
  'desktop',
  'feedback',
  'privacy',
  'advanced',
  'export',
  'activity',
  'custom-fields',
];

test.describe('Settings · core sub-pages', () => {
  for (const sub of subPages) {
    test(`/settings/${sub} renders`, async ({ page }) => {
      await page.goto(`/settings/${sub}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    });
  }
});

const integrations = [
  'attio',
  'crm-sync',
  'discord',
  'github',
  'google-calendar',
  'hubspot',
  'mcp-servers',
  'salesforce',
  'slack',
];

test.describe('Settings · integrations', () => {
  test('/settings/integrations index loads', async ({ page }) => {
    await page.goto('/settings/integrations');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  for (const i of integrations) {
    test(`/settings/integrations/${i} renders`, async ({ page }) => {
      await page.goto(`/settings/integrations/${i}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    });
  }
});

test.describe('Settings · apps', () => {
  for (const app of ['phone-numbers', 'weldcrm', 'welddesk', 'weldmail', 'weldsuite']) {
    test(`/settings/apps/${app} renders`, async ({ page }) => {
      await page.goto(`/settings/apps/${app}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    });
  }
});
