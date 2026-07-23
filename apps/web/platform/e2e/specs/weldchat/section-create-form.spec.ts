/**
 * Form spec for the WeldChat SectionCreateDialog. Covers the field
 * validation rules and the Cancel affordance.
 *
 * No data is seeded and no section is submitted — the spec exercises only
 * the client-side form state so it runs headlessly without any
 * pre-configured DB entries.
 *
 * The dialog is opened via the sidebar "New section" button. That button
 * (title="New section") is rendered in the channel section header by
 * use-weldchat-sidebar-items.tsx. The default "Channels" section is always
 * present (keepWhenEmpty), so the trigger exists even in an empty workspace.
 * It is opacity-0 until hover; force:true bypasses the visibility check.
 */

import { test, expect } from '../../fixtures';
import { openSidebarDialog } from '../../helpers/weldchat';

function openSectionCreateDialog(page: import('@playwright/test').Page) {
  // "New section" (title="New section") lives in the channel section header.
  // openSidebarDialog opens it from a stable route with a retrying
  // force-click to dodge the index-redirect + hydration races — see
  // helpers/weldchat.
  return openSidebarDialog(page, page.locator('button[title="New section"]').first());
}

test.describe('WeldChat · SectionCreateDialog form', () => {
  test('dialog renders the section-name input', async ({ page }) => {
    const dialog = await openSectionCreateDialog(page);
    await expect(dialog.locator('#section-name')).toBeVisible();
  });

  test('Create button is disabled while name is empty', async ({ page }) => {
    const dialog = await openSectionCreateDialog(page);

    // The submit button is labelled "Create section" (weldchat.sectionCreate.create).
    const createBtn = dialog.getByRole('button', { name: /create section/i });
    await expect(createBtn).toBeDisabled();
  });

  test('Create button becomes enabled after entering a name', async ({ page }) => {
    const dialog = await openSectionCreateDialog(page);

    await dialog.locator('#section-name').fill('My Section');
    const createBtn = dialog.getByRole('button', { name: /create section/i });
    await expect(createBtn).toBeEnabled();
  });

  test('Create button returns to disabled after clearing the name', async ({ page }) => {
    const dialog = await openSectionCreateDialog(page);

    const nameInput = dialog.locator('#section-name');
    await nameInput.fill('Temporary');
    const createBtn = dialog.getByRole('button', { name: /create section/i });
    await expect(createBtn).toBeEnabled();

    await nameInput.clear();
    await expect(createBtn).toBeDisabled();
  });

  test('Create button stays disabled for whitespace-only input', async ({ page }) => {
    const dialog = await openSectionCreateDialog(page);

    // handleSubmit guards with name.trim(), and the button's disabled state
    // uses the same !name.trim() check — so spaces must not enable it.
    await dialog.locator('#section-name').fill('   ');
    const createBtn = dialog.getByRole('button', { name: /create section/i });
    await expect(createBtn).toBeDisabled();
  });

  test('Cancel button closes the dialog without submitting', async ({ page }) => {
    const dialog = await openSectionCreateDialog(page);

    // Fill a name so the submit button would be enabled — proves we are not
    // relying on a disabled button to prevent submission.
    await dialog.locator('#section-name').fill('will-not-be-created');

    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});
