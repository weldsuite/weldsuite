/**
 * Form spec for the WeldChat ChannelCreateDialog. Covers field
 * validation rules, the private/public toggle branch, and the Cancel
 * affordance.
 *
 * No data is seeded and no channel is submitted — the spec exercises
 * only the client-side form state so it runs headlessly without any
 * pre-configured DB entries.
 *
 * The dialog is opened via the sidebar "New channel" button which is
 * rendered with title="New channel" by the section header add-button
 * rendered in use-weldchat-sidebar-items.tsx.
 */

import { test, expect } from '../../fixtures';
import { openSidebarDialog } from '../../helpers/weldchat';

function openChannelCreateDialog(page: import('@playwright/test').Page) {
  // The "New channel" button is rendered with title="New channel" inside the
  // sidebar section header (opacity-0 hover target). openSidebarDialog opens
  // it from a stable route with a retrying force-click — see helpers/weldchat.
  return openSidebarDialog(page, page.locator('button[title="New channel"]').first());
}

test.describe('WeldChat · ChannelCreateDialog form', () => {
  test('dialog renders the channel-name input and private toggle', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    await expect(dialog.locator('#channel-name')).toBeVisible();
    await expect(dialog.locator('#channel-private')).toBeVisible();
  });

  test('Create button is disabled while name is empty', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    // Input starts empty — button must be disabled.
    const createBtn = dialog.getByRole('button', { name: /^create$/i });
    await expect(createBtn).toBeDisabled();
  });

  test('Create button becomes enabled after entering a name', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    await dialog.locator('#channel-name').fill('my-channel');
    const createBtn = dialog.getByRole('button', { name: /^create$/i });
    await expect(createBtn).toBeEnabled();
  });

  test('Create button returns to disabled after clearing the name', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    const nameInput = dialog.locator('#channel-name');
    await nameInput.fill('temporary');
    const createBtn = dialog.getByRole('button', { name: /^create$/i });
    await expect(createBtn).toBeEnabled();

    await nameInput.clear();
    await expect(createBtn).toBeDisabled();
  });

  test('private toggle hides member picker when off and shows it when on', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    // Member picker search input should NOT be visible for public channels.
    const memberSearch = dialog.getByPlaceholder(/search members/i);
    await expect(memberSearch).not.toBeVisible();

    // Flip the toggle — the member picker search input must now appear.
    await dialog.locator('#channel-private').click();
    await expect(memberSearch).toBeVisible({ timeout: 3_000 });
  });

  test('toggling private off again hides the member picker', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    const privateSwitch = dialog.locator('#channel-private');

    // Enable private.
    await privateSwitch.click();
    const memberSearch = dialog.getByPlaceholder(/search members/i);
    await expect(memberSearch).toBeVisible({ timeout: 3_000 });

    // Disable private.
    await privateSwitch.click();
    await expect(memberSearch).not.toBeVisible();
  });

  test('Cancel button closes the dialog without submitting', async ({ page }) => {
    const dialog = await openChannelCreateDialog(page);

    // Fill a name so the submit button would be enabled — proves we are not
    // relying on a disabled button to prevent submission.
    await dialog.locator('#channel-name').fill('will-not-be-created');

    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('dialog can be opened and closed multiple times', async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      const dialog = await openChannelCreateDialog(page);
      await dialog.getByRole('button', { name: /cancel/i }).click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    }
  });
});
