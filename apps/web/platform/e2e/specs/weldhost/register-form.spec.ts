/**
 * Form spec for the WeldHost domain-registration page
 * (/weldhost/domains/register).
 *
 * The page has two states:
 *   1. Hero state  — shown before any search. Contains a single text
 *      input (data-testid="domain-search-input") and an ArrowRight submit
 *      button (data-testid="domain-search-button"). This is always reachable
 *      without seeded data.
 *   2. Results state — shown after Enter/click with a 2+ char query.
 *      DomainAvailabilityChecker renders here. We verify the transition
 *      happens but do not assert live search results (they depend on
 *      the domain-check API).
 *
 * DomainPurchaseContactForm (contact-form.tsx) is exported but NOT yet
 * wired into the page routing flow — it cannot be reached through normal
 * navigation at this time. Its Zod validation logic is covered by the
 * unit-level schema tests.
 *
 * Selector strategy: data-testid attributes on the hero form elements.
 * The BreadcrumbHeader renders its own global-search input[type="text"]
 * before the page content in DOM order, so plain input-type selectors
 * would target the wrong element.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldHost · domain register hero form', () => {
  test('hero search input is visible and accepts text', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Use testid to distinguish the hero input from the global header search.
    const searchInput = page.getByTestId('domain-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    await searchInput.fill('mycompany');
    await expect(searchInput).toHaveValue('mycompany');
  });

  test('submit button is disabled when query is empty', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByTestId('domain-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    // Input is empty by default — the ArrowRight button must be disabled.
    const arrowBtn = page.getByTestId('domain-search-button');
    await expect(arrowBtn).toBeDisabled({ timeout: 5_000 });
  });

  test('submit button is disabled when query is a single character', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByTestId('domain-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    await searchInput.fill('x');

    const arrowBtn = page.getByTestId('domain-search-button');
    await expect(arrowBtn).toBeDisabled({ timeout: 5_000 });
  });

  test('pressing Enter with 2+ characters transitions to search-results view', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByTestId('domain-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    await searchInput.fill('mycompanydomain');
    await searchInput.press('Enter');

    // After Enter the hero state is replaced by the results/availability
    // view. The DOM now shows the HostEntityFormLayout with the registration
    // title in an h2.
    await expect(page.locator('h2').filter({ hasText: /register a new domain/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('clicking the ArrowRight button with 2+ characters transitions to search-results view', async ({ page }) => {
    await page.goto('/weldhost/domains/register');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByTestId('domain-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    await searchInput.fill('mycompany');

    const arrowBtn = page.getByTestId('domain-search-button');
    await expect(arrowBtn).not.toBeDisabled({ timeout: 5_000 });
    await arrowBtn.click();

    // Hero disappears; registration layout title appears.
    await expect(page.locator('h2').filter({ hasText: /register a new domain/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
