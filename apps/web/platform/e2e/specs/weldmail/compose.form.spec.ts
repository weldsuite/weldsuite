/**
 * Form spec for the WeldMail compose surface
 * (/weldmail/$accountId/$labelSlug/compose).
 *
 * Gate: `isTestFixturesConfigured()` — requires TEST_API_URL,
 * TEST_FIXTURES_TOKEN, and TEST_WORKSPACE_ID in .env.test.
 *
 * The spec validates the compose surface fields and Send button without
 * actually sending an email (the request will fail with 4xx in the test env,
 * but that is expected and not an error the consoleErrors fixture tracks
 * because toast.error() does not call console.error).
 *
 * Cleanup is scoped: the shared mail account is deleted in afterAll rather
 * than via global api.reset(), preventing cross-worker interference.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

test.describe('WeldMail · Compose form', () => {
  let accountId = '';

  test.beforeAll(async ({ api }) => {
    // Skipped: Seeds and cleans up through app-api /test-fixtures, so it needs TEST_API_URL, TEST_FIXTURES_TOKEN and TEST_WORKSPACE_ID.
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');

    accountId = (await api.seedMailAccount()).id;
  });

  test.afterAll(async ({ api }) => {
    if (accountId) {
      await api.deleteEntity('mailAccount', accountId);
      accountId = '';
    }
  });

  test('compose route renders subject, To field, body, Send and Schedule buttons', async ({
    page,
  }) => {
    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Subject input
    const subjectInput = page.getByPlaceholder(/subject/i);
    await expect(subjectInput).toBeVisible({ timeout: 10_000 });

    // To field
    await expect(page.getByTestId('compose-to-input')).toBeVisible({ timeout: 5_000 });

    // Send button
    await expect(page.getByTestId('compose-send-btn')).toBeVisible({ timeout: 5_000 });

    // Schedule button
    await expect(page.getByTestId('compose-schedule-btn')).toBeVisible({ timeout: 5_000 });
  });

  test('filling subject and recipient enables the Send button', async ({ page }) => {
    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const subjectInput = page.getByPlaceholder(/subject/i);
    await expect(subjectInput).toBeVisible({ timeout: 10_000 });

    // Fill subject
    await subjectInput.fill('Test subject from Playwright');

    // Fill To field and commit
    const toInput = page.getByTestId('compose-to-input');
    await toInput.fill('playwright@test.example');
    await toInput.press('Enter');

    // Body (contentEditable)
    const body = page.locator('[contenteditable="true"]');
    await body.click();
    await body.type('Hello from Playwright E2E test.');

    // Send button should still be visible and enabled
    const sendBtn = page.getByTestId('compose-send-btn');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).not.toBeDisabled();
  });

  test('Close button on empty compose navigates back', async ({ page }) => {
    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('compose-close-btn')).toBeVisible({ timeout: 10_000 });

    // No content → closing just leaves (nothing to save as a draft)
    await page.getByTestId('compose-close-btn').click();

    // Should navigate back to the label view
    await expect(page).toHaveURL(new RegExp(`/weldmail/${accountId}`), { timeout: 10_000 });
  });

  test('Send without a recipient shows an inline error and focuses the To field', async ({ page }) => {
    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/subject/i).fill('No recipient yet');
    const body = page.locator('[contenteditable="true"]');
    await body.click();
    await body.type('Body without a recipient.');

    await page.getByTestId('compose-send-btn').click();

    await expect(page.getByTestId('compose-to-input-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('compose-to-input')).toBeFocused();
    // Still on the compose page: nothing was sent.
    await expect(page).toHaveURL(/\/compose/);
  });

  test('picking a recipient clears the missing-recipient error', async ({ page }) => {
    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/subject/i).fill('Recipient later');
    const body = page.locator('[contenteditable="true"]');
    await body.click();
    await body.type('Body.');
    await page.getByTestId('compose-send-btn').click();
    await expect(page.getByTestId('compose-to-input-error')).toBeVisible({ timeout: 5_000 });

    const toInput = page.getByTestId('compose-to-input');
    await toInput.fill('playwright@test.example');
    await expect(page.getByTestId('compose-to-input-error')).toBeHidden();
  });
});
