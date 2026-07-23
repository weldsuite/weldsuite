import { clerkSetup } from '@clerk/testing/playwright';
import { isTestFixturesConfigured, testFixtures } from './helpers/test-fixtures-client';

/**
 * Runs once before the whole suite.
 *
 * 1. `clerkSetup()` uses CLERK_SECRET_KEY + the publishable key
 *    (VITE_CLERK_PUBLISHABLE_KEY, picked up from .env.test) to mint a Clerk
 *    Testing Token and stash it in process.env. Each test that authenticates
 *    then calls `setupClerkTestingToken({ page })` so Clerk treats the
 *    automated browser as trusted instead of blocking it as bot traffic —
 *    without it, programmatic sign-in on a Clerk instance silently fails.
 *
 * 2. When test-fixtures are configured, install the workspace apps once. A
 *    fresh E2E workspace has zero apps, which makes AppAccessGuard redirect
 *    every module route to home — so the module suite needs this up front.
 *    Idempotent + non-fatal (a missing token / down app-api just logs).
 */
async function globalSetup(): Promise<void> {
  const publishableKey =
    process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY;
  if (publishableKey && process.env.CLERK_SECRET_KEY) {
    await clerkSetup({ publishableKey });
  } else {
    console.warn(
      '[global-setup] Clerk keys not set — skipping clerkSetup(). Authenticated specs will fail to log in.',
    );
  }

  if (isTestFixturesConfigured()) {
    try {
      const { installed } = await testFixtures.installApps();
      console.log(`[global-setup] installed ${installed.length} workspace apps: ${installed.join(', ')}`);
    } catch (err) {
      console.warn(
        `[global-setup] installApps() failed (module routes may redirect to home): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export default globalSetup;
