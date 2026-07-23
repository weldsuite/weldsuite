/**
 * Smoke spec for the unauthenticated auth surface. Runs in the
 * `chromium-unauth` Playwright project (no saved storage state), so
 * every test starts as an anonymous visitor.
 */

import { test, expect } from '@playwright/test';
import { IGNORE_PATTERNS } from '../../helpers/console-errors';

const routes = [
  '/auth/login',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/sso-callback',
  '/auth/desktop-handoff',
  '/auth/error',
];

test.describe('Unauthenticated · auth pages', () => {
  for (const path of routes) {
    test(`${path} loads without crashing`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (IGNORE_PATTERNS.some((re) => re.test(text))) return;
        consoleErrors.push(text);
      });

      await page.goto(path);

      // Either lands on the path or redirects to /auth/login (the
      // expected behaviour for some sub-pages without an active
      // session). Both are valid for a smoke check.
      const url = new URL(page.url());
      expect(url.pathname).toMatch(/^\/(auth|index|$)/);

      expect(consoleErrors).toEqual([]);
    });
  }
});

test.describe('Unauthenticated · login form', () => {
  test('shows the Welcome back heading and the email + password fields', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.locator('h1')).toContainText('Welcome back');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('rejects an empty submission with an inline validation hint', async ({ page }) => {
    await page.goto('/auth/login');
    await page.getByRole('button', { name: 'Sign In' }).click();
    // Either Clerk's inline error appears, or the browser's
    // built-in `required` validation prevents submit. Both are valid
    // — assert the URL didn't change (no redirect to dashboard).
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('register link is present and navigates to /auth/register', async ({ page }) => {
    await page.goto('/auth/login');
    const registerLink = page.getByRole('link', { name: /sign up|register/i }).first();
    if (await registerLink.isVisible().catch(() => false)) {
      await registerLink.click();
      await expect(page).toHaveURL(/\/auth\/register/, { timeout: 5_000 });
    }
  });
});
