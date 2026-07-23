/**
 * WeldMail message reading spec.
 *
 * Seeds an INBOX message on a (shared) mail account via test-fixtures, then
 * asserts it shows up in the account's inbox list and opens into the message
 * reader. Proves the list + detail surfaces load real data through app-api with
 * the signed-in session (the account is seeded `isShared` so the test user can
 * see it).
 *
 * Gate: `isTestFixturesConfigured()`.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

test.describe('WeldMail · reading', () => {
  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  let messageId = '';
  let accountId = '';

  test.afterEach(async ({ api }) => {
    if (messageId) {
      await api.deleteEntity('mailMessage', messageId).catch(() => {});
      messageId = '';
    }
    if (accountId) {
      await api.deleteEntity('mailAccount', accountId).catch(() => {});
      accountId = '';
    }
  });

  test('a seeded inbox message is listed and opens into the reader', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const subject = `E2E Read ${stamp}`;
    const msg = await api.seedMailMessage({
      subject,
      fromEmail: 'reader@external.test',
      fromName: 'Ada Reader',
      textBody: `Body content ${stamp}`,
      labels: ['INBOX'],
    });
    messageId = msg.id;
    accountId = msg.accountId;

    await page.goto(`/weldmail/${accountId}/INBOX`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The subject shows up in the conversation list — proves the list loaded
    // the seeded message through app-api with the signed-in session.
    const subjectInList = page.getByText(subject).first();
    await expect(subjectInList).toBeVisible({ timeout: 15_000 });

    // Opening it navigates to the message reader route. The list links the
    // folder segment lower-cased (`inbox`), regardless of the label's casing.
    await subjectInList.click();
    await expect(page).toHaveURL(new RegExp(`/weldmail/${accountId}/inbox/${messageId}`, 'i'), {
      timeout: 15_000,
    });
  });
});
