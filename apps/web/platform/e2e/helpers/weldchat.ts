/**
 * Shared helpers for WeldChat sidebar interactions.
 *
 * Why these exist: the structural WeldChat specs open dialogs / follow links
 * from the module sidebar. Two things make `page.goto('/weldchat')` fragile
 * when the suite runs in parallel against the shared test workspace:
 *
 *   1. The /weldchat INDEX redirects to a channel whenever ANY channel exists
 *      (page.tsx picks `find(isDefault) || data.data[0]`). A parallel
 *      messaging spec seeds channels, so the index redirects — and that late
 *      navigation (plus the sidebar re-rendering as channels come and go)
 *      races whatever the test is doing on the page.
 *   2. The sidebar "add" buttons are opacity-0 hover targets, so specs
 *      force-click them. A force-click issued before React attaches the
 *      onClick (slow hydration under parallel CPU load) is silently dropped,
 *      so the dialog never opens.
 *
 * Both are avoided by (a) navigating to a STABLE leaf route — the sidebar and
 * its New channel / New section / New DM buttons render identically on every
 * weldchat route, and a leaf route never redirects — and (b) hovering to
 * reveal the button then issuing a HIT-TESTED click (not force) so the event
 * lands on the intended button and not an adjacent one, retried until the
 * dialog actually appears.
 *
 * (A force-click skips hit-testing and dispatches at raw coordinates, so when
 * "New channel" and "New section" sit side-by-side it can silently open the
 * wrong dialog. A normal click verifies the target receives the event.)
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** A weldchat leaf route that always renders the sidebar and never redirects. */
export const WELDCHAT_STABLE_ROUTE = '/weldchat/activity';

/** Navigate to a stable weldchat route and wait for the sidebar to render. */
export async function gotoWeldchatSidebar(
  page: Page,
  route: string = WELDCHAT_STABLE_ROUTE,
): Promise<void> {
  await page.goto(route);
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
}

/**
 * Open a sidebar "add" dialog by its trigger and return the dialog locator.
 * Retries the force-click until the dialog is visible to tolerate the
 * hydration race described above.
 */
export async function openSidebarDialog(page: Page, trigger: Locator): Promise<Locator> {
  await gotoWeldchatSidebar(page);
  await expect(trigger).toBeAttached({ timeout: 10_000 });

  const dialog = page.getByRole('dialog');
  await expect(async () => {
    // Hover reveals the opacity-0 group-hover button; the non-force click then
    // hit-tests so it targets THIS button, not the one next to it.
    await trigger.hover({ force: true });
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 25_000 });

  return dialog;
}
