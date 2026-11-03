/**
 * Accessibility scan (axe) of each module's main page. TASK-1184.
 *
 * Every route is held to the shell rules: one <main>, a bypass (skip) link
 * and a valid <html lang>. The rest of axe's serious and critical findings
 * are attached to the report, and fail the test only for routes in
 * STRICT_ROUTES: each module's accessibility PR adds its route there once
 * the page is clean. `A11Y_STRICT=1` holds every route to the full set.
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../../fixtures';

const ROUTES = [
  '/',
  '/weldcrm',
  '/welddesk',
  '/weldmail',
  '/weldflow',
  '/weldchat',
  '/weldcalendar',
  '/weldbooks',
  '/welddrive',
  '/weldhr',
  '/weldmeet',
  '/weldconnect',
  '/weldstash',
  '/weldhost',
  '/appstore',
  '/settings',
];

/** Routes whose page has been cleaned up; any serious or critical finding fails. */
const STRICT_ROUTES = new Set<string>(['/weldmail']);

/** Shell-level rules every page must already pass. */
const SHELL_RULES = ['landmark-one-main', 'landmark-no-duplicate-main', 'bypass', 'html-has-lang', 'html-lang-valid'];

const strictEverywhere = process.env.A11Y_STRICT === '1';

test.describe('Accessibility · module home pages', () => {
  for (const path of ROUTES) {
    test(`${path} has no serious accessibility violations`, async ({ page }, testInfo) => {
      await page.goto(path);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('main#main-content')).toBeVisible();

      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

      await testInfo.attach('axe-violations.json', {
        body: JSON.stringify(serious, null, 2),
        contentType: 'application/json',
      });

      const shell = await new AxeBuilder({ page }).withRules(SHELL_RULES).analyze();
      expect(shell.violations.map((v) => v.id), 'shell rules').toEqual([]);

      if (strictEverywhere || STRICT_ROUTES.has(path)) {
        expect(
          serious.map((v) => `${v.id} (${v.nodes.length})`),
          'serious and critical axe violations',
        ).toEqual([]);
      }
    });
  }
});
