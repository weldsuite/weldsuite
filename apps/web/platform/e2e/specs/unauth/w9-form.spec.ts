/**
 * The public W-9 page (/w9/<token>) a vendor opens from the link they were
 * sent. Runs in the `chromium-unauth` project: no sign-in, no session. The
 * API is answered by the test (page.route), so the spec checks the page and
 * the request it sends, not the backend (books-api has its own tests).
 */

import { test, expect, type Route } from '@playwright/test';

const TOKEN = 'e2e-w9-token-0123456789abcdef';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

async function answer(route: Route, status: number, body?: unknown) {
  await route.fulfill({ status, headers: CORS, json: body });
}

test.describe('Unauthenticated · public W-9 form', () => {
  test('a vendor fills in and signs the W-9 without signing in', async ({ page }) => {
    let submitted: Record<string, unknown> | null = null;
    let submittedHeaders: Record<string, string> = {};

    await page.route(`**/public/w9/${TOKEN}`, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return answer(route, 204);
      if (request.method() === 'POST') {
        submitted = request.postDataJSON() as Record<string, unknown>;
        submittedHeaders = request.headers();
        return answer(route, 200, { data: { completed: true } });
      }
      return answer(route, 200, {
        data: {
          payer: { name: 'Acme Plumbing Supply, Inc.' },
          vendor: { displayName: 'Jane Q. Public' },
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
    });

    await page.goto(`/w9/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Form W-9' })).toBeVisible();
    await expect(page.getByText('Acme Plumbing Supply, Inc. asked for this form.')).toBeVisible();

    // An empty form is refused before anything is sent.
    await page.getByRole('button', { name: 'Sign and submit' }).click();
    await expect(page.getByText('Choose your tax classification.')).toBeVisible();
    expect(submitted).toBeNull();

    await page.getByLabel(/^Name \(as shown/).fill('Jane Q. Public');
    await page.getByRole('radio', { name: /Individual or sole proprietor/ }).click();
    await page.getByLabel(/^Street address/).fill('1 Main St');
    await page.getByLabel(/^City/).fill('Austin');
    await page.getByRole('combobox', { name: /^State/ }).click();
    await page.getByRole('option', { name: /TX · Texas/ }).click();
    await page.getByLabel(/^ZIP code/).fill('78701');
    await page.getByRole('radio', { name: /^SSN/ }).click();

    // What is typed in the number field is hidden until the eye is pressed.
    const number = page.getByLabel(/^Number \*/);
    await number.fill('123456789');
    await expect(number).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show the number' }).click();
    await expect(number).toHaveValue('123-45-6789');

    await page.getByLabel(/^Signature/).fill('Jane Q. Public');
    await page.getByRole('checkbox', { name: /I certify, under penalties of perjury/ }).click();
    await page.getByRole('button', { name: 'Sign and submit' }).click();

    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await expect(page.getByText('Your W-9 was sent to Acme Plumbing Supply, Inc.')).toBeVisible();

    expect(submitted).toEqual({
      legalName: 'Jane Q. Public',
      federalTaxClassification: 'individual',
      address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
      tinType: 'ssn',
      tin: '123-45-6789',
      signedName: 'Jane Q. Public',
      certify: true,
    });
    // The link is the only credential: no session goes with the request.
    expect(submittedHeaders.authorization).toBeUndefined();
    expect(submittedHeaders.cookie).toBeUndefined();
    // Nothing the vendor typed stays on the thank-you page.
    await expect(page.locator('body')).not.toContainText('123-45-6789');
  });

  test('says the link is not available for an unknown, expired or used link', async ({ page }) => {
    await page.route(`**/public/w9/${TOKEN}`, async (route) => {
      if (route.request().method() === 'OPTIONS') return answer(route, 204);
      return answer(route, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
    await page.goto(`/w9/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'This link is not available' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign and submit' })).toHaveCount(0);
  });

  test('stays readable on a phone: no sideways scrolling', async ({ page }) => {
    await page.route(`**/public/w9/${TOKEN}`, async (route) => {
      if (route.request().method() === 'OPTIONS') return answer(route, 204);
      return answer(route, 200, {
        data: { payer: { name: 'Acme' }, vendor: { displayName: 'Jane' }, expiresAt: '2099-01-01T00:00:00.000Z' },
      });
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w9/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Form W-9' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
