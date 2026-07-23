/**
 * E2E spec for the WeldMail email-accounts settings surface
 * (/settings/apps/weldmail) — covers BOTH creating and viewing accounts.
 *
 * Two layers:
 *
 *  1. Structural (always runs, no seeded data) — asserts the page chrome and
 *     the "Add Email" dialog wiring: provider picker, custom-domain step and
 *     WeldMail-address step all render and are reachable.
 *
 *  2. Seed-gated (`isTestFixturesConfigured()`) — exercises real data:
 *       · VIEW   — seed a mail account via /test-fixtures, then assert it shows
 *                  up in the list. This proves the list loads through app-api
 *                  (`GET /api/mail-accounts`), the path the settings hook was
 *                  migrated onto.
 *       · CREATE — seed an active WeldHost domain so the custom-domain form
 *                  renders, fill it in, submit, and assert the request that
 *                  reaches `POST /api/mail-accounts` carries `name`, `email`
 *                  and `displayName` (the `name` field is the regression guard
 *                  — its omission previously produced a ZodError). The POST is
 *                  fulfilled with a synthetic `{ data }` envelope so the success
 *                  UX (toast + dialog close) is deterministic and independent of
 *                  the live Cloudflare Email-Routing provisioning the real
 *                  endpoint performs.
 *
 * Cleanup is scoped to the rows each test seeded (NOT a global `api.reset()`):
 * under `fullyParallel` every spec shares one test workspace, so a global wipe
 * would delete sibling specs' in-flight rows.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

const ACCOUNTS_URL = '/settings/apps/weldmail';

// ---------------------------------------------------------------------------
// 1. Structural — Add Email dialog wiring (no seeded data required)
// ---------------------------------------------------------------------------

test.describe('WeldMail · accounts settings (structural)', () => {
  test('renders the page heading and the Add Email button', async ({ page }) => {
    await page.goto(ACCOUNTS_URL);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('heading', { name: /email accounts/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('button', { name: /add email/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Add Email opens the provider picker dialog', async ({ page }) => {
    await page.goto(ACCOUNTS_URL);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /add email/i }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The select step exposes the three creation/connect CTAs.
    await expect(dialog.getByRole('button', { name: /connect outlook/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /weldmail address/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /custom domain email/i })).toBeVisible();
  });

  test('Custom Domain Email step renders (form or "add a domain" helper)', async ({ page }) => {
    await page.goto(ACCOUNTS_URL);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /add email/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /custom domain email/i }).click();

    // Depending on whether the workspace owns an active domain, the step shows
    // either the email-prefix input or a WeldHost helper. Either way the back
    // chevron and a forward action are present — assert the step changed by
    // checking the "Email Name" label OR the WeldHost helper copy.
    await expect(
      dialog
        .getByText(/email name/i)
        .or(dialog.getByText(/weldhost/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('WeldMail Address step renders the address input', async ({ page }) => {
    await page.goto(ACCOUNTS_URL);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /add email/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /weldmail address/i }).click();

    await expect(dialog.locator('#weldmail-address')).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 2a. Viewing — a seeded account appears in the list (loads via app-api)
// ---------------------------------------------------------------------------

test.describe('WeldMail · view accounts', () => {
  let accountId = '';

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (accountId) {
      await api.deleteEntity('mailAccount', accountId);
      accountId = '';
    }
  });

  test('a seeded mail account is listed on the settings page', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const seeded = await api.seedMailAccount({ name: `E2EView ${stamp}` });
    accountId = seeded.id;

    await page.goto(ACCOUNTS_URL);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The list renders the account's email address — proves the app-api
    // `GET /api/mail-accounts` load reached the UI.
    await expect(page.getByText(seeded.email, { exact: false })).toBeVisible({
      timeout: 15_000,
    });
  });
});

// ---------------------------------------------------------------------------
// 2b. Creating — custom-domain flow sends the correct app-api request
// ---------------------------------------------------------------------------

test.describe('WeldMail · create account (custom domain)', () => {
  let domainId = '';

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (domainId) {
      await api.deleteEntity('domain', domainId);
      domainId = '';
    }
  });

  test('custom-domain create posts name/email/displayName to app-api', async ({ page, api }) => {
    const stamp = Date.now().toString(36);

    // Seed an active WeldHost domain so the custom-domain form has something to
    // select. createMailAccount requires the domain to already exist in
    // WeldHost, and the picker only lists domains in "active" status.
    const domain = await api.seedDomain({ status: 'active' });
    domainId = domain.id;

    const prefix = `e2e${stamp}`;
    const displayName = `E2E Create ${stamp}`;
    const expectedEmail = `${prefix}@${domain.fullDomain}`;

    // Intercept the create call: capture its payload and fulfill it with a
    // synthetic `{ data }` envelope. This keeps the success path deterministic
    // (the real endpoint provisions Cloudflare Email Routing, which can't
    // succeed for a throw-away seeded domain). Every other /mail-accounts call
    // (the list GET that refetches after success) is passed straight through.
    let createPayload: Record<string, unknown> | null = null;
    await page.route('**/api/mail-accounts**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST' && path.endsWith('/mail-accounts')) {
        createPayload = req.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 'mail_e2e_mock',
              name: createPayload.name,
              email: createPayload.email,
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(ACCOUNTS_URL);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Open dialog → Custom Domain Email step.
    await page.getByRole('button', { name: /add email/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /custom domain email/i }).click();

    // The form renders once the active-domains query resolves.
    const prefixInput = dialog.locator('#email-prefix');
    await expect(prefixInput).toBeVisible({ timeout: 15_000 });

    // Explicitly pick the seeded domain (other specs may have seeded their own
    // active domains in the shared test workspace, so don't rely on the
    // auto-selected first entry).
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: domain.fullDomain, exact: true }).click();

    await prefixInput.fill(prefix);
    await dialog.locator('#display-name').fill(displayName);

    // Submit and wait for the intercepted POST to land.
    const [createReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'POST' &&
          new URL(r.url()).pathname.endsWith('/mail-accounts'),
      ),
      dialog.getByRole('button', { name: /create email/i }).click(),
    ]);
    expect(createReq).toBeTruthy();

    // Contract: the create request carries the full payload. `name` is the
    // regression guard — when it was missing the server rejected with a
    // ZodError ("name: Required").
    expect(createPayload).toMatchObject({
      name: displayName,
      email: expectedEmail,
      displayName,
    });

    // Success UX: toast shown and the dialog closes.
    await expect(page.getByText(/email account created successfully/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });
});
