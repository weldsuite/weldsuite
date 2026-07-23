/**
 * Interaction spec for WeldChat. Verifies that each sub-page renders,
 * primary CTAs are present, and the Create Channel / New DM dialogs
 * open from the sidebar.
 *
 * No data seeding is used — every assertion targets structural UI that
 * must exist regardless of workspace content.
 */

import { test, expect } from '../../fixtures';
import { gotoWeldchatSidebar, openSidebarDialog } from '../../helpers/weldchat';

// ---------------------------------------------------------------------------
// Static sub-pages
// ---------------------------------------------------------------------------

test.describe('WeldChat · activity page', () => {
  test('renders the activity list with the Mark all read button', async ({ page }) => {
    await page.goto('/weldchat/activity');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldchat\/activity/);

    // The "Mark all read" button is always rendered in the action bar,
    // even when the list is empty — it uses the i18n key weldchat.markAllRead.
    const markAllReadBtn = page.getByRole('button', { name: /mark all read/i });
    await expect(markAllReadBtn).toBeVisible({ timeout: 10_000 });
  });

  test('activity page has a filter toolbar', async ({ page }) => {
    await page.goto('/weldchat/activity');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The groupBy popover trigger (labelled "Type" by default) proves the
    // EntityList toolbar rendered.
    const groupByBtn = page.getByRole('button', { name: /^type$/i });
    await expect(groupByBtn).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('WeldChat · drafts page', () => {
  test('renders the drafts list', async ({ page }) => {
    await page.goto('/weldchat/drafts');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldchat\/drafts/);
  });

  test('drafts page has the groupBy toolbar control', async ({ page }) => {
    await page.goto('/weldchat/drafts');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The groupBy popover trigger (labelled "Type" by default) is always
    // rendered — it proves the EntityList toolbar mounted correctly.
    const groupByBtn = page.getByRole('button', { name: /^type$/i });
    await expect(groupByBtn).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('WeldChat · directories page', () => {
  test('renders the directories member list', async ({ page }) => {
    await page.goto('/weldchat/directories');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldchat\/directories/);
  });
});

test.describe('WeldChat · bookmarks page', () => {
  test('renders the Saved Items header', async ({ page }) => {
    await page.goto('/weldchat/bookmarks');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldchat\/bookmarks/);

    // The "Saved Items" heading is always rendered in the page header,
    // regardless of whether any bookmarks exist (weldchat.bookmarks.savedItems).
    await expect(
      page.getByRole('heading', { name: /saved items/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Sidebar navigation — Activity / Drafts / Directories links
// ---------------------------------------------------------------------------

// Start from /weldchat/bookmarks — a stable leaf route that renders the
// sidebar but is NOT one of the three top-nav targets, so clicking each link
// is a real navigation. Using the /weldchat index here would be flaky: it
// redirects to a channel whenever one exists (e.g. seeded by a parallel
// messaging spec) and that late redirect races the link click.
test.describe('WeldChat · sidebar top-nav links', () => {
  test('Activity link is reachable from the WeldChat sidebar', async ({ page }) => {
    await gotoWeldchatSidebar(page, '/weldchat/bookmarks');
    const link = page.getByRole('link', { name: /^Activity$/i });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page).toHaveURL(/\/weldchat\/activity/, { timeout: 10_000 });
  });

  test('Drafts link is reachable from the WeldChat sidebar', async ({ page }) => {
    await gotoWeldchatSidebar(page, '/weldchat/bookmarks');
    const link = page.getByRole('link', { name: /^Drafts$/i });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page).toHaveURL(/\/weldchat\/drafts/, { timeout: 10_000 });
  });

  test('Directories link is reachable from the WeldChat sidebar', async ({ page }) => {
    await gotoWeldchatSidebar(page, '/weldchat/bookmarks');
    const link = page.getByRole('link', { name: /^Directories$/i });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page).toHaveURL(/\/weldchat\/directories/, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Create Channel dialog
// ---------------------------------------------------------------------------

const openChannelDialog = (page: import('@playwright/test').Page) =>
  openSidebarDialog(page, page.locator('button[title="New channel"]').first());

test.describe('WeldChat · Create Channel dialog', () => {
  test('New channel button opens the ChannelCreateDialog', async ({ page }) => {
    const dialog = await openChannelDialog(page);
    // The ChannelCreateDialog renders a dialog with the channel-name input.
    await expect(dialog.locator('#channel-name')).toBeVisible();
  });

  test('ChannelCreateDialog disables Create button when channel name is empty', async ({ page }) => {
    const dialog = await openChannelDialog(page);
    // Submit button should be disabled while name is empty.
    const createBtn = dialog.getByTestId('channel-create-submit');
    await expect(createBtn).toBeDisabled();
  });

  test('ChannelCreateDialog enables Create button when name is filled', async ({ page }) => {
    const dialog = await openChannelDialog(page);
    await dialog.locator('#channel-name').fill('e2e-test-channel');
    const createBtn = dialog.getByTestId('channel-create-submit');
    await expect(createBtn).toBeEnabled();
  });

  test('private toggle reveals the member picker', async ({ page }) => {
    const dialog = await openChannelDialog(page);

    // The private channel switch is labelled via htmlFor="channel-private".
    const privateSwitch = dialog.locator('#channel-private');
    await expect(privateSwitch).toBeVisible();

    // Before toggling: member picker is not present.
    await expect(dialog.getByPlaceholder(/search members/i)).not.toBeVisible();

    // After toggling: member picker search input appears.
    await privateSwitch.click();
    await expect(dialog.getByPlaceholder(/search members/i)).toBeVisible({ timeout: 3_000 });
  });

  test('ChannelCreateDialog closes via Cancel button', async ({ page }) => {
    const dialog = await openChannelDialog(page);
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// New DM dialog
// ---------------------------------------------------------------------------

// The sidebar renders the onAdd button for the "Direct Messages" group with
// an sr-only "Add Direct Messages" label (opacity-0 hover target).
const openDmDialog = (page: import('@playwright/test').Page) =>
  openSidebarDialog(page, page.getByRole('button', { name: /add direct messages/i }));

test.describe('WeldChat · New DM dialog', () => {
  test('New DM button on the Direct Messages group opens the DmCreateDialog', async ({ page }) => {
    const dialog = await openDmDialog(page);
    // DmCreateDialog renders a search textbox for selecting people.
    const searchInput = dialog.getByRole('textbox');
    await expect(searchInput).toBeVisible();
  });

  test('DmCreateDialog Start Conversation button is disabled with no selection', async ({ page }) => {
    const dialog = await openDmDialog(page);
    // The "Start Conversation" button must be disabled when no member is selected.
    const startBtn = dialog.getByRole('button', { name: /start conversation/i });
    await expect(startBtn).toBeDisabled();
  });

  test('DmCreateDialog accepts text in the people search field', async ({ page }) => {
    const dialog = await openDmDialog(page);

    // The search box filters the member list client-side; verify it is wired
    // up and retains input. The member set is workspace-dependent, so we don't
    // assert on the resulting rows — only that the controlled input works.
    const searchInput = dialog.getByPlaceholder(/search people/i);
    await searchInput.fill('zzz-no-match');
    await expect(searchInput).toHaveValue('zzz-no-match');

    // Start Conversation stays disabled — typing alone selects nobody.
    await expect(
      dialog.getByRole('button', { name: /start conversation/i }),
    ).toBeDisabled();
  });

  test('DmCreateDialog closes via Cancel button', async ({ page }) => {
    const dialog = await openDmDialog(page);
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});
