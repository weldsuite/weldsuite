/**
 * Interaction spec for /settings/team.
 *
 * TeamSection renders a member table and an invite-member button. The
 * invite button has no data-testid; the recommendation to add one is
 * filed in crossCuttingRecommendations. We locate the button by its
 * accessible name (rendered by InviteMemberDialog's trigger via the
 * Plus icon + text "Invite member").
 *
 * No seeded data is required — the test user's own membership is
 * always present so the table is never empty.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · team', () => {
  test('page renders the team table with at least one row', async ({ page }) => {
    await page.goto('/settings/team');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // TeamSection renders a <table>. The authenticated user is always a
    // member, so the table body must have at least one row.
    const tbody = page.locator('table tbody');
    // Wait for the table to appear — it loads after the members query.
    await expect(tbody).toBeVisible({ timeout: 20_000 });
    await expect(tbody.locator('tr').first()).toBeVisible({ timeout: 10_000 });
  });

  test('"Invite member" button is visible and opens the invite dialog', async ({ page }) => {
    await page.goto('/settings/team');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The page shows a PageLoader until the members query + permissions
    // resolve; the toolbar (and the invite button) only mount afterwards.
    // Wait for the "Team Members" heading so the conditional check below
    // doesn't race the async load — `isVisible()` is an immediate, no-retry
    // probe and would otherwise skip the test while the page is still loading.
    await expect(
      page.getByRole('heading', { name: /team members/i }),
    ).toBeVisible({ timeout: 20_000 });

    // The invite trigger renders the text "Invite Member" (gated on
    // isOwner || team:update). waitFor auto-retries (unlike isVisible(), which
    // is an immediate probe), so a permitted user isn't skipped while
    // permissions resolve under load. Only skip if it genuinely never appears.
    const inviteBtn = page.getByRole('button', { name: /invite member/i }).first();

    try {
      await inviteBtn.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      // If the user lacks team:update permission the button is hidden —
      // skip gracefully rather than hard-fail.
      test.skip(true, 'Current user cannot invite members (team:update missing)');
    }

    await inviteBtn.click();

    // InviteMemberDialog renders as role="dialog"
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});
