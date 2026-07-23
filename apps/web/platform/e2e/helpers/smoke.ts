/**
 * Shared smoke helper. Runs the same lightweight checks against a list
 * of URLs:
 *   - Page navigates and lands on the expected URL.
 *   - The app sidebar is visible (proves the auth shell rendered, not
 *     just an error boundary).
 *
 * `networkidle` is deliberately NOT used — the WeldSuite SPA holds
 * realtime/websocket connections open, so networkidle is unreliable
 * across modules. Each assertion is locator-based with auto-retry.
 *
 * Console errors are caught by the auto-applied `consoleErrors` fixture
 * in fixtures.ts — no need to repeat that here.
 */

import { expect, type Page } from '@playwright/test';

export interface SmokeRoute {
  /** URL path to visit. Can be `/weldcrm` or `/weldcrm/people?filter=x`. */
  path: string;
  /**
   * Regex the URL must match after navigation. Defaults to a regex built
   * from `path` (escaped). Useful when the route redirects (e.g.
   * /weldcrm/customers → /weldcrm/companies?filter=customers).
   */
  expectedUrl?: RegExp;
}

export async function smokeRoute(page: Page, route: SmokeRoute): Promise<void> {
  await page.goto(route.path);

  // Sidebar must be present — proves the auth shell rendered. The
  // expect retry handles slow first paint without an arbitrary sleep.
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

  const expected =
    route.expectedUrl ??
    new RegExp(route.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\?/, '\\?'));
  await expect(page).toHaveURL(expected, { timeout: 10_000 });
}
