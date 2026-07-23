/**
 * Full E2E spec: new-user signup + workspace creation (onboarding).
 *
 * Placement: `e2e/specs/unauth/` so it runs in the `chromium-unauth`
 * Playwright project (no saved Clerk session — starts as an anonymous
 * visitor). The `testMatch` in playwright.config.ts picks it up automatically.
 *
 * What this covers:
 *   1. `/auth/register`  — custom Clerk useSignUp() form (not Clerk's hosted UI)
 *   2. Email OTP         — Clerk test-mode fixed code 424242
 *   3. `/onboarding`     — 4-step wizard: Profile → Organization → Role → Apps
 *   4. Provisioning      — real Clerk org + Neon tenant-DB creation (~1–3 min)
 *   5. `/`              — assert an authenticated dashboard marker
 *   6. Teardown          — deletes the throwaway org + tenant DB via the
 *                          `/test-fixtures/teardown-workspace` endpoint (Part A).
 *
 * Prerequisites:
 *   - `.env.test` must have TEST_API_URL, TEST_FIXTURES_TOKEN, TEST_WORKSPACE_ID
 *     (so teardown can authenticate). The spec skips if any are absent.
 *   - The Clerk instance must be a TEST instance so the +clerk_test email trick
 *     and the fixed OTP 424242 work.
 *   - CLERK_SECRET_KEY + VITE_CLERK_PUBLISHABLE_KEY must point at the test instance.
 */

import { test, expect } from '../../fixtures';
import { testFixtures, isTestFixturesConfigured } from '../../helpers/test-fixtures-client';
import { setupClerkTestingToken } from '@clerk/testing/playwright';

// ---------------------------------------------------------------------------
// Per-run identity
// ---------------------------------------------------------------------------

const stamp = Date.now();
// The +clerk_test subaddress tells the Clerk test instance to accept OTP 424242
// instead of sending a real email.
const email = `weldsuite-e2e+clerk_test_${stamp}@example.com`;
// Password meets: 8+ chars, uppercase, lowercase, digit.
const password = `E2eTest!${stamp}`;
const orgName = `E2E Onboarding ${stamp}`;
const firstName = 'E2E';
const lastName = 'Tester';

// Captured after the org is created so afterAll can tear it down.
let createdOrgId: string | null = null;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Onboarding — new-user signup + workspace creation', () => {
  // Skip gracefully when the test-fixtures infrastructure isn't wired (e.g.
  // a local dev machine without .env.test). This keeps CI green during rollout.
  test.beforeAll(() => {
    test.skip(
      !isTestFixturesConfigured(),
      'TEST_API_URL / TEST_FIXTURES_TOKEN / TEST_WORKSPACE_ID not set — skipping onboarding teardown spec',
    );
  });

  // Real workspace provisioning takes up to 3 minutes. Add margin for
  // signup + wizard interaction on top.
  test.setTimeout(240_000);

  test('full signup → onboarding wizard → dashboard', async ({ page }) => {
    // ------------------------------------------------------------------
    // 1. Sign-up page
    // ------------------------------------------------------------------

    // Inject the Clerk Testing Token so the test instance trusts this
    // automated browser — same pattern as auth.setup.ts.
    await setupClerkTestingToken({ page });

    await page.goto('/auth/register');

    // Wait for Clerk to initialise before interacting — useSignUp().isLoaded
    // must flip true or the form submit is a silent no-op.
    await page.waitForFunction(
      () =>
        (window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true,
      null,
      { timeout: 30_000 },
    );

    await expect(page.locator('h1')).toContainText('Create an account');

    // Fill registration fields.
    await page.locator('#firstName').fill(firstName);
    await page.locator('#lastName').fill(lastName);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#confirmPassword').fill(password);

    // The Create Account button is disabled until passwords match AND the
    // Clerk hook is loaded. Assert it is enabled before clicking — a
    // regression in Clerk load timing would fail loudly here.
    const createAccountBtn = page.getByRole('button', { name: 'Create Account' });
    await expect(createAccountBtn).toBeEnabled({ timeout: 10_000 });

    await createAccountBtn.click();

    // ------------------------------------------------------------------
    // 2. Email verification (OTP)
    // ------------------------------------------------------------------

    // Wait for the transition to the OTP step (the component re-renders
    // in place; the URL stays /auth/register).
    await expect(page.locator('h1')).toContainText('Verify your email', {
      timeout: 30_000,
    });

    // The InputOTP component renders individual slot inputs. The
    // `[data-input-otp]` attribute is added to the root input (used by the
    // register page's auto-focus useEffect). Type into the OTP container.
    // Playwright types character-by-character into whichever slot has focus.
    const otpInput = page.locator('[data-input-otp]');
    await otpInput.focus();
    await otpInput.type('424242');

    // The onChange handler auto-clicks #verify-btn when 6 digits are
    // entered. Wait for the redirect rather than clicking verify-btn manually
    // — but fall back to clicking it if the redirect hasn't started after 3 s.
    const verifyBtn = page.locator('#verify-btn');
    await Promise.race([
      page.waitForURL('/onboarding', { timeout: 30_000 }),
      verifyBtn
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => verifyBtn.click())
        .catch(() => {
          // verify-btn may not be separately clicked if auto-submit already fired
        }),
    ]);

    await page.waitForURL('/onboarding', { timeout: 30_000 });

    // ------------------------------------------------------------------
    // 3. Wizard — Step 1: Profile (1/4 · "Set up your profile")
    // ------------------------------------------------------------------

    // The wizard renders the step indicator as "{stepIndex + 1}/{totalSteps}".
    await expect(page.getByText('1/4')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Set up your profile' })).toBeVisible();

    // Names should be prefilled from Clerk; #email must be disabled.
    const wizardFirstName = page.locator('#firstName');
    const wizardLastName = page.locator('#lastName');
    await expect(wizardFirstName).toHaveValue(firstName);
    await expect(wizardLastName).toHaveValue(lastName);
    await expect(page.locator('#email')).toBeDisabled();

    // Gating contract: clearing a name disables Continue.
    const continueBtn = page.getByTestId('onboarding-continue-btn');
    await wizardFirstName.clear();
    await expect(continueBtn).toBeDisabled();
    await wizardFirstName.fill(firstName);
    await expect(continueBtn).toBeEnabled();

    await continueBtn.click();

    // ------------------------------------------------------------------
    // 4. Wizard — Step 2: Organization (2/4 · "Set up your workspace")
    // ------------------------------------------------------------------

    await expect(page.getByText('2/4')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: 'Set up your workspace' }),
    ).toBeVisible();

    await page.locator('#organizationName').fill(orgName);

    // Country combobox: open via stable testid, search, and pick Netherlands
    // (code NL → EU → auto-sets region to aws-eu-central-1).
    const countryTrigger = page.getByTestId('onboarding-country-combobox');
    await countryTrigger.click();
    const countrySearch = page.getByPlaceholder('Search country...');
    await countrySearch.fill('Netherlands');
    await page.getByRole('option', { name: 'Netherlands' }).click();

    // Region is a shadcn Select with id="region". After selecting Netherlands
    // the region auto-sets to Europe (Frankfurt); assert it has a non-empty
    // value before proceeding.
    const regionSelect = page.locator('#region');
    await expect(regionSelect).toBeVisible();
    // The SelectTrigger renders the selected value as visible text inside it.
    // After the country auto-set the placeholder "Select region" should be gone
    // and a region label should be present.
    await expect(regionSelect).not.toContainText('Select region');

    // Organization size — Select with id="organizationSize".
    const orgSizeSelect = page.locator('#organizationSize');
    await orgSizeSelect.click();
    await page.getByRole('option', { name: 'Just me' }).click();

    // Referral source — plain Input with id.
    await page.locator('#referralSource').fill('Friend or Colleague');

    // Gating: all required fields are now filled, Continue should be enabled.
    const continueBtn2 = page.getByTestId('onboarding-continue-btn');
    await expect(continueBtn2).toBeEnabled({ timeout: 5_000 });
    await continueBtn2.click();

    // ------------------------------------------------------------------
    // 5. Wizard — Step 3: Role (3/4 · "Tell us about your role")
    // ------------------------------------------------------------------

    await expect(page.getByText('3/4')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: 'Tell us about your role' }),
    ).toBeVisible();

    // Role buttons are <div role="button" data-testid="onboarding-role-btn">
    // with the role label text. Filter by name to pick "Engineering".
    await page
      .getByTestId('onboarding-role-btn')
      .filter({ hasText: 'Engineering' })
      .click();

    // The selected role button gets border-primary styling — assert it carries
    // an aria state or just that the Continue button is now enabled.
    const continueBtn3 = page.getByTestId('onboarding-continue-btn');
    await expect(continueBtn3).toBeEnabled();
    await continueBtn3.click();

    // ------------------------------------------------------------------
    // 6. Wizard — Step 4: Apps (4/4 · "Choose your apps")
    // ------------------------------------------------------------------

    await expect(page.getByText('4/4')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: 'Choose your apps' }),
    ).toBeVisible();

    // Get Started is disabled at 0 selected apps.
    const getStartedBtn = page.getByTestId('onboarding-get-started-btn');
    await expect(getStartedBtn).toBeDisabled();

    // Pick the first app button. App buttons are
    // <div role="button" data-testid="onboarding-app-btn"> rendered from
    // visibleApps. We need at least 1 selected to unlock Get Started.
    const firstApp = page.getByTestId('onboarding-app-btn').first();
    await firstApp.click();

    // After selecting 1 app the count indicator appears.
    await expect(page.getByText(/1 app selected/)).toBeVisible();

    // Get Started is now enabled.
    await expect(getStartedBtn).toBeEnabled();

    // Click — triggers real provisioning. The wizard calls completeOnboarding()
    // which creates the Clerk org + Neon tenant DB, then polls the DB status.
    await getStartedBtn.click();

    // ------------------------------------------------------------------
    // 7. Provisioning screen + dashboard redirect
    // ------------------------------------------------------------------

    // The page shows a provisioning screen ("Setting up your workspace") while
    // the DB spins up. This can take up to 3 minutes.
    await expect(
      page.getByRole('heading', { name: 'Setting up your workspace' }),
    ).toBeVisible({ timeout: 15_000 });

    // Confirm the first provisioning step label is visible.
    await expect(page.getByText('Creating your database')).toBeVisible();

    // Wait for the hard redirect to '/'. The provisioning hook polls
    // /onboarding/database-status and does window.location.href = '/' when done.
    await page.waitForURL('/', { timeout: 200_000 });

    // Capture the Clerk org id for teardown. At this point setActive has run
    // so Clerk.organization.id should be populated.
    createdOrgId = await page.evaluate(() => {
      const clerk = (
        window as {
          Clerk?: {
            organization?: { id?: string } | null;
          };
        }
      ).Clerk;
      return clerk?.organization?.id ?? null;
    });

    test.info().annotations.push({
      type: 'created-org-id',
      description: createdOrgId ?? '(not captured)',
    });

    // Confirm an authenticated dashboard surface is visible. The home shell
    // renders after the Clerk session is active.
    // We check Clerk.user rather than a specific testid because the dashboard
    // sidebar (data-testid="app-sidebar") only mounts on module routes — the
    // home route renders a different shell (same pattern as auth.setup.ts).
    await page.waitForFunction(
      () =>
        Boolean(
          (window as { Clerk?: { user?: unknown } }).Clerk?.user,
        ),
      null,
      { timeout: 30_000 },
    );
  });

  // --------------------------------------------------------------------------
  // Teardown: remove the throwaway Clerk org + tenant DB.
  // Best-effort — a failure here must NOT mask a real test failure above.
  // --------------------------------------------------------------------------

  test.afterAll(async () => {
    if (!createdOrgId) {
      // Either the test was skipped or provisioning failed before we could
      // capture the org id. Nothing to clean up.
      return;
    }

    try {
      await testFixtures.teardownWorkspace(createdOrgId);
    } catch (err) {
      // Log but do not rethrow — teardown failure is a warning, not a test
      // failure. The CI alert channel + Playwright report will surface it.
      console.warn(
        `[onboarding-e2e] afterAll teardownWorkspace(${createdOrgId}) failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
});
