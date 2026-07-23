/**
 * WeldData module E2E spec.
 *
 * Covers the whole module through the UI with the `/welddata/*` API fully
 * mocked (see helpers/welddata.ts), so it runs deterministically without
 * Lemlist / Findymail / Prospeo / Anthropic keys or DB seeding:
 *
 *   · Navigation + module sidebar (Find Leads, All Lists, dynamic Lists group)
 *   · Find Leads search — gating, people vs company columns, tabs
 *   · Filter sidebar (curated labels + inputs)
 *   · Add-to-list from search selection (kind-scoped)
 *   · All Lists overview (cards, kind badge, create dialog with kind selector)
 *   · List detail grid — company columns, enrichment cell, per-cell play button,
 *     cell detail dialog, run-row, Move-to-CRM, Add-column dialog (web search +
 *     email finder + templates)
 *
 * Selectors lean on stable test-ids (`app-sidebar`, `entity-grid`,
 * `entity-grid-row`) and English UI copy; a first run may need minor selector
 * triage as noted in e2e/README.md.
 */

import { test, expect } from '../../fixtures';
import { EntityGridPage } from '../../pages/entity-grid.page';
import {
  mockWelddata,
  PERSON_LIST,
  COMPANY_LIST,
  LONG_CELL_VALUE,
  type WelddataMockState,
} from '../../helpers/welddata';

let mock: WelddataMockState;

test.beforeEach(async ({ page }) => {
  mock = await mockWelddata(page);
});

async function waitForShell(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Navigation + module sidebar
// ---------------------------------------------------------------------------

test.describe('WeldData · navigation & sidebar', () => {
  test('Find Leads page renders with the filter sidebar and search prompt', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    await expect(page.getByRole('tab', { name: /people/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: /companies/i })).toBeVisible();
    // Idle state before a search.
    await expect(page.getByText(/run a search to find leads/i)).toBeVisible();
  });

  test('module sidebar shows Find Leads, All Lists and the workspace lists', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    // The WeldData module sidebar renders its nav + a dynamic Lists group
    // (fed by the mocked GET /welddata/lists). These links live in the module
    // sidebar, not the global `app-sidebar` rail.
    await expect(page.getByRole('link', { name: 'Find Leads' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'All Lists' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: PERSON_LIST.name, exact: true }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: COMPANY_LIST.name, exact: true }).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test.describe('WeldData · filter sidebar', () => {
  test('renders curated filter labels for the People tab', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    // A few of the hard-coded catalog labels (people mode).
    await expect(page.getByText('Current job title', { exact: true })).toBeVisible();
    await expect(page.getByText('Seniority', { exact: true })).toBeVisible();
    await expect(page.getByText('Company industry', { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Find Leads — search
// ---------------------------------------------------------------------------

test.describe('WeldData · search', () => {
  test('Search is disabled until a filter or keyword is set', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    const searchBtn = page.getByRole('button', { name: 'Search', exact: true });
    await expect(searchBtn).toBeDisabled();

    await page.getByPlaceholder(/name, company, keyword/i).fill('engineer');
    await expect(searchBtn).toBeEnabled();
  });

  test('People search renders person columns (incl. Job title)', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    await page.getByPlaceholder(/name, company, keyword/i).fill('engineer');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    const grid = new EntityGridPage(page);
    await grid.waitForReady();
    await expect(page.getByText('Grace Hopper', { exact: false })).toBeVisible({ timeout: 15_000 });
    // Person grids include the Job title column header.
    await expect(page.getByRole('columnheader', { name: /job title/i })).toBeVisible();
  });

  test('Company search renders company columns (no Job title)', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    await page.getByRole('tab', { name: /companies/i }).click();
    await page.getByPlaceholder(/name, company, keyword/i).fill('payments');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    const grid = new EntityGridPage(page);
    await grid.waitForReady();
    // `exact` — "Stripe" also appears in the domain/LinkedIn cells.
    await expect(page.getByText('Stripe', { exact: true })).toBeVisible({ timeout: 15_000 });
    // Company grids drop the person-only Job title column.
    await expect(page.getByRole('columnheader', { name: /job title/i })).toHaveCount(0);
  });

  test('selecting a result and adding it to a list posts the lead', async ({ page }) => {
    await page.goto('/welddata');
    await waitForShell(page);

    await page.getByPlaceholder(/name, company, keyword/i).fill('engineer');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    // Select the row, then use the grid selection bar's "Add to list".
    await grid.rows().first().getByRole('checkbox').first().click();
    await page.getByRole('button', { name: /add to list/i }).click();
    // Only person-kind lists are offered for a People search.
    await page.getByRole('option', { name: PERSON_LIST.name }).click();

    await expect(page.getByText(/saved 1 lead/i)).toBeVisible({ timeout: 10_000 });
    expect(mock.lastAddLeads?.listId).toBe(PERSON_LIST.id);
  });
});

// ---------------------------------------------------------------------------
// All Lists overview
// ---------------------------------------------------------------------------

test.describe('WeldData · all lists', () => {
  test('lists render as cards with a person/company kind badge', async ({ page }) => {
    await page.goto('/welddata/lists');
    await waitForShell(page);

    // Names appear in both the sidebar and the cards — `.first()` is enough to
    // prove the overview rendered.
    await expect(page.getByText(PERSON_LIST.name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(COMPANY_LIST.name, { exact: true }).first()).toBeVisible();
    // Kind badges (People / Companies) appear on the cards.
    await expect(page.getByText('Companies', { exact: true }).first()).toBeVisible();
  });

  test('New list dialog offers the People/Companies kind selector', async ({ page }) => {
    await page.goto('/welddata/lists');
    await waitForShell(page);

    await page.getByRole('button', { name: /new list/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('button', { name: /companies/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /people/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// List detail — grid + enrichment
// ---------------------------------------------------------------------------

test.describe('WeldData · list detail', () => {
  test('company list shows company columns (no Job title)', async ({ page }) => {
    await page.goto(`/welddata/lists/${COMPANY_LIST.id}`);
    await waitForShell(page);

    const grid = new EntityGridPage(page);
    await grid.waitForReady();
    // `exact` — "Globex" also appears in the domain/LinkedIn cells.
    await expect(page.getByText('Globex', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('columnheader', { name: /job title/i })).toHaveCount(0);
  });

  test('person list shows the enrichment column and its cell value', async ({ page }) => {
    await page.goto(`/welddata/lists/${PERSON_LIST.id}`);
    await waitForShell(page);

    const grid = new EntityGridPage(page);
    await grid.waitForReady();
    // `exact` — the name also appears inside the (long) enrichment cell value.
    await expect(page.getByText('Ada Lovelace', { exact: true })).toBeVisible({ timeout: 15_000 });
    // The enrichment column header + the (clamped) cell value.
    await expect(page.getByRole('columnheader', { name: 'CEO' })).toBeVisible();
    await expect(page.getByText(/Chief Technology Officer/i)).toBeVisible();
  });

  test('clicking an enrichment cell opens the full-detail dialog', async ({ page }) => {
    await page.goto(`/welddata/lists/${PERSON_LIST.id}`);
    await waitForShell(page);

    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    await page.getByText(/Chief Technology Officer/i).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // The dialog shows the full (un-clamped) value + a Copy action.
    await expect(dialog.getByText(LONG_CELL_VALUE, { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /copy/i })).toBeVisible();
  });

  test('the per-cell play button runs a single cell', async ({ page }) => {
    await page.goto(`/welddata/lists/${PERSON_LIST.id}`);
    await waitForShell(page);

    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    // The cell's run button (title "Re-run" for a completed cell).
    const cellRun = grid.rows().first().getByRole('button', { name: /re-run/i }).first();
    await cellRun.click();
    expect(mock.runCellCount).toBeGreaterThan(0);
  });

  test('Add column dialog exposes templates, web search and the email-finder provider', async ({ page }) => {
    await page.goto(`/welddata/lists/${PERSON_LIST.id}`);
    await waitForShell(page);
    await new EntityGridPage(page).waitForReady();

    await page.getByRole('button', { name: /add column/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // AI column wiring: template picker + the web-search toggle.
    await expect(dialog.getByText(/start from a template/i)).toBeVisible();
    await expect(dialog.getByText(/search the web/i)).toBeVisible();

    // Switching the action to Email finder reveals the provider picker.
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /email finder/i }).click();
    await expect(dialog.getByText(/provider/i)).toBeVisible();
  });

  test('row context menu offers Move to CRM bulk action via selection', async ({ page }) => {
    await page.goto(`/welddata/lists/${PERSON_LIST.id}`);
    await waitForShell(page);

    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    // Selecting a lead surfaces the bulk action bar with "Move to CRM".
    await grid.rows().first().getByRole('checkbox').first().click();
    await expect(page.getByRole('button', { name: /move to crm/i })).toBeVisible({ timeout: 10_000 });
  });
});
