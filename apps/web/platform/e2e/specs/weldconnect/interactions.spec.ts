/**
 * Interaction spec for WeldConnect (Workflows + automations).
 *
 * Covers per-page structural assertions and primary CTA flows that do
 * not require seeded data. The full create→assert CRUD flows live in
 * the separate crud-*.spec.ts files.
 */

import { test, expect } from '../../fixtures';

// ---------------------------------------------------------------------------
// Variable page — the only entity in the module with a stable data-testid
// ---------------------------------------------------------------------------

test.describe('WeldConnect · variables page', () => {
  test('create-variable button is visible and opens the dialog', async ({ page }) => {
    await page.goto('/weldconnect/variables');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByTestId('page-header-action-create-variable');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    await btn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Name + value fields must be present inside the dialog
    await expect(dialog.locator('#name')).toBeVisible();
    await expect(dialog.locator('#value')).toBeVisible();
  });

  test('variable dialog closes when cancel is clicked', async ({ page }) => {
    await page.goto('/weldconnect/variables');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('page-header-action-create-variable').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Webhooks page
// ---------------------------------------------------------------------------

test.describe('WeldConnect · webhooks page', () => {
  test('Create Webhook button is visible and opens the dialog', async ({ page }) => {
    await page.goto('/weldconnect/webhooks');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The button carries no testId — locate by role + text
    const btn = page.getByRole('button', { name: /create webhook/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });

    await btn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Name input inside the dialog
    await expect(dialog.locator('#name')).toBeVisible();
  });

  test('webhook create dialog closes when cancel is clicked', async ({ page }) => {
    await page.goto('/weldconnect/webhooks');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /create webhook/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Workflows page
// ---------------------------------------------------------------------------

test.describe('WeldConnect · workflows page', () => {
  test('New workflow button is visible on the workflows list', async ({ page }) => {
    await page.goto('/weldconnect/workflows');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The create button in WorkflowsClient calls handleNewWorkflow (no dialog
    // for the default workflow category — it creates immediately and navigates).
    // Use .first() because an empty-state action button also matches the same label.
    const btn = page.getByRole('button', { name: /new workflow/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
  });
});
