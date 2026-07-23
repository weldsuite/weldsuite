import { test as setup, expect } from '@playwright/test';
import { setupClerkTestingToken } from '@clerk/testing/playwright';
import path from 'path';

const authFile = path.join(__dirname, '.auth/user.json');

setup('authenticate', async ({ page }) => {
  // Inject the Clerk Testing Token (minted in global-setup) so the dev Clerk
  // instance trusts this automated browser; without it the sign-in below is
  // silently rejected and the page never leaves /auth/login.
  await setupClerkTestingToken({ page });

  await page.goto('/auth/login');

  // Wait for Clerk to load and the form to be interactive
  await expect(page.locator('h1')).toContainText('Welcome back');

  // The Sign In button is `disabled` until Clerk's useSignIn().isLoaded flips
  // true. Clicking before that is a silent no-op (no sign-in request fires),
  // which previously left the page stuck on /auth/login. Wait for Clerk to
  // finish initializing first.
  await page.waitForFunction(() => (window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true, null, {
    timeout: 30_000,
  });

  // Fill credentials
  await page.locator('#email').fill(process.env.TEST_USER_EMAIL!);
  await page.locator('#password').fill(process.env.TEST_USER_PASSWORD!);

  // Submit the form — assert the button is enabled so a regression in Clerk
  // load timing fails loudly here rather than silently not signing in.
  const signInButton = page.getByRole('button', { name: 'Sign In' });
  await expect(signInButton).toBeEnabled();
  await signInButton.click();

  // Wait for successful redirect away from auth pages
  await expect(page).not.toHaveURL(/\/auth\//, { timeout: 30000 });

  // Confirm a real Clerk session exists before snapshotting. We assert on
  // `Clerk.user` rather than `app-sidebar` because post-login lands on `/`
  // (the home shell), which renders a different sidebar component without
  // that testid — the dashboard `app-sidebar` only mounts on module routes.
  // Clerk.user being set means the session cookies are written and the
  // storageState snapshot below will be valid for the authed projects.
  await page.waitForFunction(
    () => Boolean((window as { Clerk?: { user?: unknown } }).Clerk?.user),
    null,
    { timeout: 15_000 },
  );

  // Save the authenticated state
  await page.context().storageState({ path: authFile });
});
