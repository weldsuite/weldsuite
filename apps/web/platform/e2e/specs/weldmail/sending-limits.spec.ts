/**
 * WeldMail outbound guard (docs/plans/weldmail-outbound-abuse.md): what a
 * person sees when a send is refused, the banner while sending is restricted,
 * and the Sending limits tab in Settings.
 *
 * The send POST and `GET /api/mail-sending/usage` are intercepted with
 * `page.route`, so nothing really sends and the spec does not depend on the
 * workspace's trust level or the guard's mode.
 *
 * Gate: `isTestFixturesConfigured()` — needs a seeded mail account to drive the
 * compose route.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

const SEND_GLOB = '**/mail-accounts/*/send';
const USAGE_GLOB = '**/mail-sending/usage';

const usage = {
  mode: 'enforce',
  trustLevel: 'new',
  state: 'active',
  stateReason: null,
  limits: {
    recipientsPerMessage: 20,
    senderPerHour: 30,
    senderPerDay: 150,
    workspacePerDay: 300,
    firstContactPerDay: 50,
    repliesPerSenderPerDay: 150,
    monthlyRecipients: null,
  },
  workspace: {
    hour: 4,
    day: { used: 120, limit: 300 },
    firstContactDay: { used: 45, limit: 50 },
    month: { used: 1234, limit: null },
  },
  senders: [{ email: 'anna@example.com', hour: { used: 4, limit: 30 }, day: { used: 120, limit: 150 } }],
  deliveries7d: { delivered: 980, hardBounces: 3, softBounces: 12, complaints: 1, rejected: 2 },
  coldOutreachCapped: false,
};

async function stubUsage(page: Page, body: unknown) {
  await page.route(USAGE_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) }),
  );
}

async function stubDenial(page: Page, code: string, details: Record<string, unknown>, status = 429) {
  await page.route(SEND_GLOB, (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message: `${code} message`, details } }),
    }),
  );
}

async function fillAndSend(page: Page, accountId: string) {
  await page.goto(`/weldmail/${accountId}/INBOX/compose`);
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder(/subject/i).fill('Limit test');
  const toInput = page.getByTestId('compose-to-input');
  await toInput.fill('to@example.com');
  await toInput.press('Enter');
  await page.getByTestId('compose-body').click();
  await page.keyboard.type('Hello from the sending limits spec.');
  await page.getByPlaceholder(/subject/i).click();
  await page.getByTestId('compose-send-btn').click();
}

test.describe('WeldMail · Sending limits', () => {
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

  test('a volume limit names the limit and keeps the message open', async ({ page, consoleErrors }) => {
    await stubUsage(page, null);
    await stubDenial(page, 'SENDING_LIMITED', {
      window: 'day',
      limit: 150,
      used: 150,
      retryAfter: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    });

    await fillAndSend(page, accountId);

    await expect(page.getByText('You have reached your daily sending limit.')).toBeVisible();
    await expect(page.getByText(/Limit: 150 recipients per day\./)).toBeVisible();
    await expect(page.getByText(/You can send again in 5 hours\./)).toBeVisible();
    // Nothing is lost: the compose screen is still there with its recipient.
    await expect(page.getByTestId('compose-send-btn')).toBeVisible();
    await expect(page.getByText('to@example.com')).toBeVisible();
    // The browser logs the 429 itself; it is the point of this test.
    consoleErrors.errors.length = 0;
  });

  test('the first-contact limit points outreach at WeldReach', async ({ page, consoleErrors }) => {
    await stubUsage(page, null);
    await stubDenial(page, 'FIRST_CONTACT_LIMITED', { window: 'day', limit: 50, reason: 'workspace_first_contact' });

    await fillAndSend(page, accountId);

    await expect(page.getByText(/WeldMail is for one-to-one email/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request WeldReach access' })).toBeVisible();
    // The browser logs the 429 itself; it is the point of this test.
    consoleErrors.errors.length = 0;
  });

  test('a restricted workspace sees a banner that says replies still work', async ({ page }) => {
    await stubUsage(page, { ...usage, state: 'restricted' });

    await page.goto(`/weldmail/${accountId}/INBOX`);

    const banner = page.getByTestId('mail-sending-restriction-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('Sending is restricted');
    await expect(banner).toContainText('You can still reply to messages you have received.');
  });

  test('no banner while sending is normal', async ({ page }) => {
    await stubUsage(page, usage);

    await page.goto(`/weldmail/${accountId}/INBOX`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('mail-sending-restriction-banner')).toHaveCount(0);
  });

  test('the Sending limits tab shows usage against the limits', async ({ page }) => {
    await stubUsage(page, usage);

    await page.goto('/settings/apps/weldmail?tab=limits');

    await expect(page.getByText('Trust level')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('120 of 300')).toBeVisible();
    await expect(page.getByText('45 of 50')).toBeVisible();
    await expect(page.getByText('anna@example.com')).toBeVisible();
    await expect(page.getByText('Deliveries, last 7 days')).toBeVisible();
  });

  test('the tab is hidden when the guard is not available', async ({ page }) => {
    await stubUsage(page, null);

    await page.goto('/settings/apps/weldmail');

    await expect(page.getByRole('tab', { name: 'Signatures' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: 'Sending limits' })).toHaveCount(0);
  });
});
