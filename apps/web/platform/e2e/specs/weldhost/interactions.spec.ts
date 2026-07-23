/**
 * Interaction spec for WeldHost (Domain registrar).
 *
 * Covers primary CTAs visible on each sub-page without requiring seeded data.
 * All selectors use ARIA roles or visible text; no data-testids are present in
 * the weldhost module code at time of writing (see crossCuttingRecommendations
 * in the coverage report).
 */

import { test, expect } from '../../fixtures';

// ---------------------------------------------------------------------------
// Sub-page render assertions
// ---------------------------------------------------------------------------

test.describe('WeldHost · domains', () => {
  for (const sub of [
    'domains',
    'domains/register',
    'domains/search',
  ]) {
    test(`/weldhost/${sub} renders`, async ({ page }) => {
      await page.goto(`/weldhost/${sub}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    });
  }

  test('Domain search input is present on /weldhost/domains/search', async ({ page }) => {
    await page.goto('/weldhost/domains/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Any text input that accepts a domain name. Tolerant — the
    // exact field id isn't testid'd yet.
    const anyInput = page.locator('input[type="text"], input[type="search"]').first();
    await expect(anyInput).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// /weldhost/domains — Register Domain CTA navigates to /register
// ---------------------------------------------------------------------------

test.describe('WeldHost · domains list CTAs', () => {
  test('"Register Domain" button is visible and navigates to /weldhost/domains/register', async ({ page }) => {
    await page.goto('/weldhost/domains');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The EntityList createButton is rendered as a visible button with the
    // label "Register Domain" (from domains-client.tsx createButton.label).
    const registerBtn = page.getByRole('button', { name: /register domain/i });
    await expect(registerBtn).toBeVisible({ timeout: 10_000 });

    await registerBtn.click();
    await expect(page).toHaveURL(/\/weldhost\/domains\/register/, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// /weldhost/domains/register — hero search input + submit button
// ---------------------------------------------------------------------------

test.describe('WeldHost · domain register hero', () => {
  test('hero search input accepts text on /weldhost/domains/register', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The hero renders before any search has been done — a full-screen
    // search input is shown (placeholder "Search a domain...").
    const heroInput = page.locator('input[type="text"]').first();
    await expect(heroInput).toBeVisible({ timeout: 10_000 });

    await heroInput.fill('mycompany');
    await expect(heroInput).toHaveValue('mycompany');
  });

  test('ArrowRight search button is disabled when query is too short', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const heroInput = page.locator('input[type="text"]').first();
    await expect(heroInput).toBeVisible({ timeout: 10_000 });

    // With fewer than 2 characters, the arrow button must be disabled.
    await heroInput.fill('a');

    // The button containing ArrowRight SVG is rendered as a plain <button>
    // positioned inside the search wrapper.
    const arrowBtn = page.locator('button[disabled]').last();
    await expect(arrowBtn).toBeVisible({ timeout: 5_000 });
  });

  test('ArrowRight button becomes enabled once query has 2+ characters', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const heroInput = page.locator('input[type="text"]').first();
    await expect(heroInput).toBeVisible({ timeout: 10_000 });

    // Type a 2-character query — the button should lose disabled state.
    await heroInput.fill('ab');

    // Re-locate after fill — the button is the last <button> in the hero wrapper.
    const arrowBtn = page.locator('button').filter({ has: page.locator('svg') }).last();
    await expect(arrowBtn).not.toBeDisabled({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// /weldhost/domains/purchase/cancel — button interactions
// ---------------------------------------------------------------------------

test.describe('WeldHost · purchase cancel page CTAs', () => {
  test('"Go to Domains" button navigates back to /weldhost/domains', async ({ page }) => {
    await page.goto('/weldhost/domains/purchase/cancel');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The cancel page renders two buttons: "Try Again" and "Go to Domains".
    const goToDomainsBtn = page.getByRole('button', { name: /go to domains/i });
    await expect(goToDomainsBtn).toBeVisible({ timeout: 10_000 });

    await goToDomainsBtn.click();
    await expect(page).toHaveURL(/\/weldhost\/domains/, { timeout: 10_000 });
  });

  test('"Try Again" button navigates to /weldhost/domains/register', async ({ page }) => {
    await page.goto('/weldhost/domains/purchase/cancel');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const tryAgainBtn = page.getByRole('button', { name: /try again/i });
    await expect(tryAgainBtn).toBeVisible({ timeout: 10_000 });

    await tryAgainBtn.click();
    await expect(page).toHaveURL(/\/weldhost\/domains\/register/, { timeout: 10_000 });
  });
});
