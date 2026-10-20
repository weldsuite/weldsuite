import { test, expect } from '../fixtures';

/**
 * Platform URLs name the workspace (FE-013): `/w/{slug}/…` in the address bar.
 *
 * The cross-workspace case needs the test user in a second workspace; set
 * TEST_SECOND_WORKSPACE_SLUG in .env.test to run it.
 */

const WORKSPACE_URL = /\/w\/([^/]+)\//;

function workspaceOf(url: string): string {
  const match = WORKSPACE_URL.exec(new URL(url).pathname + '/');
  if (!match) throw new Error(`No workspace in ${url}`);
  return match[1];
}

test.describe('Workspace in the URL', () => {
  test('a bare path gains the workspace slug, in place', async ({ page }) => {
    await page.goto('/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/w\/[^/]+\/weldcrm/, { timeout: 10_000 });
  });

  test('links, navigation and reloads keep the workspace', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-nav-welddesk')).toBeVisible({ timeout: 15_000 });
    const slug = workspaceOf(page.url());

    // The rail is plain <a> tags: their hrefs must carry the workspace too,
    // so open-in-new-tab and copy-link keep it.
    await expect(page.getByTestId('app-nav-welddesk')).toHaveAttribute('href', `/w/${slug}/welddesk`);

    await page.getByTestId('app-nav-welddesk').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/welddesk`), { timeout: 10_000 });

    await page.reload();
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/welddesk`));
  });

  test('a workspace the user is not in shows the workspace list, not another workspace', async ({ page }) => {
    await page.goto('/w/no-such-workspace-e2e/weldcrm');
    await expect(page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('app-sidebar')).toHaveCount(0);
    await expect(page.getByText('Open this page in:')).toBeVisible();
  });

  test('a link to another workspace switches this tab to it', async ({ page }) => {
    const other = process.env.TEST_SECOND_WORKSPACE_SLUG;
    test.skip(!other, 'TEST_SECOND_WORKSPACE_SLUG is not set');

    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    const first = workspaceOf(page.url());

    await page.goto(`/w/${other}/weldcrm`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/w/${other}/weldcrm`));

    // And back, so the session ends where it started for the next spec.
    await page.goto(`/w/${first}/`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/w/${first}/`));
  });
});
