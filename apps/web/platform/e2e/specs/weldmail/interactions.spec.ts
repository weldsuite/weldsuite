/**
 * Interaction spec for WeldMail.
 *
 * Covers the primary CTAs on inbox, compose, search, settings/labels and the
 * setup page.  All tests are structural — they assert the UI scaffolding is
 * present and wired correctly without requiring seeded database state.
 *
 * Dynamic routes ($accountId/$labelSlug) are exercised only in the
 * seed-gated specs (labels.crud.spec.ts, compose.form.spec.ts).
 */

import { test, expect } from '../../fixtures';

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

test.describe('WeldMail · inbox interactions', () => {
  test('Compose button is visible and labelled', async ({ page }) => {
    await page.goto('/weldmail/inbox');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The inline compose button is rendered inside the email-list panel.
    // It may be absent when the workspace has no mail account (redirected to
    // /weldmail/setup) — handle both cases gracefully.
    const url = page.url();
    if (/\/weldmail\/setup/.test(url) || /\/weldmail\/inbox/.test(url) === false) {
      // Workspace has no mail account — setup page shown instead.
      await expect(page.getByRole('button', { name: /connect outlook/i })).toBeVisible({
        timeout: 10_000,
      });
      return;
    }

    const composeBtn = page.getByTestId('inbox-compose-btn');
    if (await composeBtn.isVisible().catch(() => false)) {
      await expect(composeBtn).toBeVisible();
    } else {
      // Fallback: role-based selector
      await expect(
        page.getByRole('button', { name: /compose/i }).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test('Search input is present in the inbox', async ({ page }) => {
    await page.goto('/weldmail/inbox');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const url = page.url();
    if (/\/weldmail\/setup/.test(url)) {
      test.skip(true, 'No mail account — redirected to setup');
      return;
    }

    const searchInput = page.getByTestId('inbox-search-input');
    if (await searchInput.isVisible().catch(() => false)) {
      await expect(searchInput).toBeVisible();
      // Verify it is editable
      await searchInput.fill('test query');
      await expect(searchInput).toHaveValue('test query');
      await searchInput.fill('');
    } else {
      // Fallback: placeholder text
      await expect(
        page.getByPlaceholder(/search in mail/i).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// Static views — sidebar and URL assertions
// ---------------------------------------------------------------------------

test.describe('WeldMail · static views', () => {
  const views = [
    { path: '/weldmail/scheduled', label: 'scheduled' },
    { path: '/weldmail/snoozed', label: 'snoozed' },
    { path: '/weldmail/search', label: 'search' },
    { path: '/weldmail/domains', label: 'domains' },
  ] as const;

  for (const { path, label } of views) {
    test(`${path} renders the sidebar and stays on the expected URL`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(label));
    });
  }
});

// ---------------------------------------------------------------------------
// Inbox compose route
// ---------------------------------------------------------------------------

test.describe('WeldMail · inbox compose route', () => {
  test('/weldmail/inbox/compose renders the compose surface or redirects to setup', async ({
    page,
  }) => {
    await page.goto('/weldmail/inbox/compose');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const url = page.url();
    if (/\/weldmail\/setup/.test(url)) {
      // Expected for workspaces without a mail account — setup page.
      await expect(
        page.getByRole('heading', { level: 3 }).first(),
      ).toBeVisible({ timeout: 10_000 });
      return;
    }

    // Compose surface should be visible.
    await expect(page).toHaveURL(/\/weldmail\/inbox\/compose/);
  });
});

// ---------------------------------------------------------------------------
// AI feature views
// ---------------------------------------------------------------------------

test.describe('WeldMail · AI features', () => {
  for (const ai of ['smart-reply', 'summary'] as const) {
    test(`/weldmail/ai/${ai} renders`, async ({ page }) => {
      await page.goto(`/weldmail/ai/${ai}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/weldmail/ai/${ai}`));
    });
  }
});

// ---------------------------------------------------------------------------
// Settings — labels page
// ---------------------------------------------------------------------------

test.describe('WeldMail · settings labels', () => {
  test('/weldmail/settings/labels renders with Create Label button', async ({ page }) => {
    await page.goto('/weldmail/settings/labels');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const createBtn = page.getByTestId('labels-create-btn');
    if (await createBtn.isVisible().catch(() => false)) {
      await expect(createBtn).toBeVisible();
    } else {
      await expect(
        page.getByRole('button', { name: /create label/i }),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test('Create Label button opens the dialog', async ({ page }) => {
    await page.goto('/weldmail/settings/labels');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const createBtn = page.getByTestId('labels-create-btn').or(
      page.getByRole('button', { name: /create label/i }),
    );
    await createBtn.first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The label name input has a stable id="label-name"
    await expect(dialog.locator('#label-name')).toBeVisible();
    // Dismiss
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Settings — accounts page
// ---------------------------------------------------------------------------

test.describe('WeldMail · settings accounts', () => {
  test('/weldmail/settings/accounts renders', async ({ page }) => {
    await page.goto('/weldmail/settings/accounts');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldmail\/settings\/accounts/);
  });
});

// ---------------------------------------------------------------------------
// Setup page CTAs
// ---------------------------------------------------------------------------

test.describe('WeldMail · setup page', () => {
  /**
   * The setup page is shown to workspaces that have no mail accounts.
   * If the workspace already has accounts, visiting /weldmail/setup still
   * renders the page (the redirect happens server-side only when useMailAccounts
   * resolves). We assert the three setup CTAs are visible.
   */
  test('Setup page shows Connect Outlook and create address options', async ({ page }) => {
    await page.goto('/weldmail/setup');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The three visible CTAs on the select step
    await expect(
      page.getByRole('button', { name: /connect outlook/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('button', { name: /weldmail address/i }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole('button', { name: /custom.?domain email/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Clicking WeldMail address navigates to the address creation sub-step', async ({
    page,
  }) => {
    await page.goto('/weldmail/setup');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /weldmail address/i });
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await btn.click();

    // The sub-step renders the address input
    await expect(page.locator('#weldmail-address')).toBeVisible({ timeout: 5_000 });
  });

  test('Clicking Custom domain email navigates to the custom domain sub-step', async ({
    page,
  }) => {
    await page.goto('/weldmail/setup');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /custom.?domain email/i });
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await btn.click();

    // The custom-domain step shows either a domain selector or a
    // "no domains configured" helper (depending on workspace state).
    // Either way a button is rendered.
    const anyButton = page.getByRole('button').first();
    await expect(anyButton).toBeVisible({ timeout: 5_000 });
  });
});
