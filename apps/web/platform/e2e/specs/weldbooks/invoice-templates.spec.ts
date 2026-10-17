/**
 * Spec for the invoice designer (/settings/entities/:id/invoice-templates).
 * Assumes the test workspace has an accounting entity and that the test user
 * may edit the accounting settings. It creates one template and deletes it
 * again, so the seeded data is left as it was.
 *
 * Verifies:
 *   1. The WeldBooks settings (the WeldBooks tab of the entity in Settings →
 *      Entities, where /weldbooks/settings leads) link to the templates page.
 *   2. A template is created from a preset and opens in the designer, still
 *      in Settings.
 *   3. Adding a block enables Save, undo takes it back, Save persists.
 *   4. The new template shows up on the list and can be deleted.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldBooks · invoice templates', () => {
  test('creates, edits and deletes a template', async ({ page }) => {
    const name = `E2E template ${Date.now()}`;

    await page.goto('/weldbooks/settings');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: /manage templates/i }).click();
    await expect(page).toHaveURL(/\/settings\/entities\/[^/]+\/invoice-templates$/, { timeout: 10_000 });

    // Either the header button or, on an empty list, the empty-state one.
    const create = page.getByRole('button', { name: /^(new template|create your first template)$/i }).first();
    await expect(create).toBeVisible({ timeout: 10_000 });
    await create.click();
    await page.locator('#template-name').fill(name);
    await page.getByRole('button', { name: /create and design/i }).click();

    await expect(page).toHaveURL(/\/settings\/entities\/[^/]+\/invoice-templates\/[^/]+$/, { timeout: 15_000 });
    const save = page.getByRole('button', { name: /^save$/i });
    await expect(save).toBeDisabled();

    // Add a text block from the palette: the template is dirty, undo makes it clean again.
    await page.getByRole('button', { name: /^add text$/i }).click();
    await expect(save).toBeEnabled();
    await page.getByRole('button', { name: /^undo$/i }).click();
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: /^redo$/i }).click();
    await expect(save).toBeEnabled();

    await save.click();
    await expect(page.getByText(/template saved/i)).toBeVisible({ timeout: 10_000 });
    await expect(save).toBeDisabled();

    // Back to the list: the template is there; delete it.
    await page.getByRole('link', { name: /back to templates/i }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: new RegExp(`template actions: ${name}`, 'i') }).click();
    await page.getByRole('menuitem', { name: /^delete$/i }).click();
    await page.getByRole('button', { name: /^delete$/i }).click();
    await expect(page.getByRole('heading', { name })).toHaveCount(0, { timeout: 10_000 });
  });
});
