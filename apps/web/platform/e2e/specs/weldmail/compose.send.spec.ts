/**
 * WeldMail compose → send PAYLOAD spec (/weldmail/$accountId/$labelSlug/compose).
 *
 * Verifies the compose UI assembles the correct outbound request: To / Cc / Bcc
 * recipients and uploaded attachments. The send POST (and the R2 upload chain
 * for attachments) is intercepted with `page.route` so the test is deterministic
 * and never actually sends mail — the assertion is on the request body the UI
 * produced. The backend's handling of that body (cc/bcc/attachment persistence)
 * is covered separately by the API-level dry-run tests in `e2e/api/mail.spec.ts`.
 *
 * Gate: `isTestFixturesConfigured()` — needs a seeded mail account to drive the
 * compose route.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

/** Matches the app-api compose endpoint regardless of host/prefix. */
const SEND_GLOB = '**/mail-accounts/*/send';
const isSendRequest = (url: string) => /\/mail-accounts\/[^/]+\/send$/.test(new URL(url).pathname);

/** Fulfil the send POST with a synthetic success envelope (never really sends). */
async function stubSend(page: import('@playwright/test').Page) {
  await page.route(SEND_GLOB, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { messageId: 'msg_mock' } }),
    }),
  );
}

test.describe('WeldMail · Compose send payload', () => {
  let accountId = '';

  test.beforeAll(async ({ api }) => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
    accountId = (await api.seedMailAccount()).id;
  });

  test.afterAll(async ({ api }) => {
    if (accountId) {
      await api.deleteEntity('mailAccount', accountId);
      accountId = '';
    }
  });

  test('To / Cc / Bcc all reach the send request body', async ({ page }) => {
    await stubSend(page);

    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/subject/i).fill('CC/BCC payload test');

    const toInput = page.getByPlaceholder(/add recipients/i);
    await toInput.fill('to@example.com');
    await toInput.press('Enter');

    // Reveal + fill Cc and Bcc.
    await page.getByTestId('compose-cc-toggle').click();
    await page.getByTestId('compose-cc-input').fill('cc@example.com');
    await page.getByTestId('compose-bcc-toggle').click();
    await page.getByTestId('compose-bcc-input').fill('bcc@example.com');

    // Body must be non-empty; blur (click subject) so its state commits.
    await page.getByTestId('compose-body').click();
    await page.keyboard.type('Hello from the compose payload test.');
    await page.getByPlaceholder(/subject/i).click();

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && isSendRequest(r.url())),
      page.getByTestId('compose-send-btn').click(),
    ]);
    const payload = req.postDataJSON() as Record<string, unknown>;

    expect(payload.to).toEqual(expect.arrayContaining(['to@example.com']));
    expect(payload.cc).toEqual(expect.arrayContaining(['cc@example.com']));
    expect(payload.bcc).toEqual(expect.arrayContaining(['bcc@example.com']));
    expect(payload.subject).toBe('CC/BCC payload test');
  });

  test('multiple comma-separated Cc / Bcc recipients are split into arrays', async ({ page }) => {
    await stubSend(page);

    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const toInput = page.getByPlaceholder(/add recipients/i);
    await toInput.fill('primary@example.com');
    await toInput.press('Enter');

    await page.getByTestId('compose-cc-toggle').click();
    await page.getByTestId('compose-cc-input').fill('cc1@example.com, cc2@example.com');
    await page.getByTestId('compose-bcc-toggle').click();
    await page.getByTestId('compose-bcc-input').fill('bcc1@example.com; bcc2@example.com');

    await page.getByTestId('compose-body').click();
    await page.keyboard.type('Body.');
    await page.getByPlaceholder(/subject/i).click();

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && isSendRequest(r.url())),
      page.getByTestId('compose-send-btn').click(),
    ]);
    const payload = req.postDataJSON() as Record<string, unknown>;

    expect(payload.cc).toEqual(['cc1@example.com', 'cc2@example.com']);
    expect(payload.bcc).toEqual(['bcc1@example.com', 'bcc2@example.com']);
  });

  test('an attached file is uploaded and referenced in the send body', async ({ page }) => {
    // Mock the R2 upload chain: generate-upload-url → PUT → (then send).
    await page.route('**/storage/generate-upload-url', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          uploadUrl: 'https://mock-upload.test/put',
          uploadToken: 'tok',
          fileKey: 'workspaces/test/mock-note.txt',
        }),
      }),
    );
    await page.route('https://mock-upload.test/put', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );
    await stubSend(page);

    await page.goto(`/weldmail/${accountId}/INBOX/compose`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/subject/i).fill('With attachment');
    const toInput = page.getByPlaceholder(/add recipients/i);
    await toInput.fill('rcpt@example.com');
    await toInput.press('Enter');

    await page.getByTestId('compose-body').click();
    await page.keyboard.type('See attached.');
    await page.getByPlaceholder(/subject/i).click();

    // Attach a small file via the (hidden) toolbar file input.
    await page.getByTestId('compose-attach-input').setInputFiles({
      name: 'note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello world'),
    });

    // The attachment preview should show the file name (without extension).
    await expect(page.getByText('note', { exact: false }).first()).toBeVisible({ timeout: 10_000 });

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && isSendRequest(r.url())),
      page.getByTestId('compose-send-btn').click(),
    ]);
    const payload = req.postDataJSON() as Record<string, unknown>;

    const attachments = payload.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('note.txt');
    expect(attachments[0].fileKey).toBe('workspaces/test/mock-note.txt');
  });
});
