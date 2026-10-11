import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Partner portal (reseller licensing).
 *
 * The portal is driven by `/api/partner/*`, which needs a partner to exist in
 * the master database. These specs answer those calls from the test instead, so
 * they exercise the UI (routing without an active workspace, role-gated
 * actions, the live price preview) with the signed-in test user and no seeded
 * partner. The backend is covered by the app-api tests.
 */

const partnerInfo = {
  id: 'ptr_e2e',
  name: 'Acme Partner',
  logoUrl: null,
  websiteUrl: 'https://partner.example',
  supportEmail: 'help@partner.example',
  supportUrl: null,
};

const contract = {
  id: 'ptc_e2e',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  currency: 'USD',
  revenueShareBps: 7500,
  baseMinimum: '50.00',
  includedCredits: 2000,
  creditFloorPrice: '0.004',
  extraCreditPrice: '0.01',
  allowedFeaturePlanIds: [],
  paymentTermsDays: 30,
  pastDueAfterDays: 14,
  readOnlyAfterDays: 30,
};

const workspaceRow = {
  workspaceId: 'ws_e2e',
  name: 'Acme Industries',
  slug: 'acme-industries',
  provisioningStatus: 'ready',
  ownerEmail: 'owner@acme.example',
  licence: {
    status: 'active',
    packageId: null,
    allowedApps: ['welddesk'],
    monthlyCredits: 2000,
    creditRolloverCap: 0,
    maxSeats: null,
    featurePlanId: null,
    storageGb: null,
    resalePricing: { model: 'flat', amount: '400.00' },
    startsAt: '2026-03-01T00:00:00.000Z',
    endsAt: null,
  },
  packageName: null,
  activeMembers: 3,
  creditsUsedThisPeriod: 500,
  creditBalance: 1500,
  estimate: { resale: 40000, share: 30000, baseFloor: 5000, creditFloor: 0, floor: 5000, due: 30000, margin: 10000, basis: 'share' },
  createdAt: '2026-03-01T00:00:00.000Z',
};

type Role = 'owner' | 'admin' | 'billing' | 'viewer';

/** Answer a cross-origin API call (and its preflight) with JSON. */
async function fulfill(route: Route, body: unknown, status = 200) {
  const origin = route.request().headers().origin ?? '*';
  const cors = {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: cors });
    return;
  }
  await route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function mockPartnerApi(page: Page, memberships: Array<{ role: Role; status?: string }>) {
  await page.route('**/api/partner/me', (route) =>
    fulfill(route, {
      data: memberships.map((m) => ({
        partnerId: partnerInfo.id,
        partnerName: partnerInfo.name,
        role: m.role,
        status: m.status ?? 'active',
      })),
    }),
  );
  if (memberships.length === 0) return;

  const role = memberships[0]!.role;
  await page.route('**/api/partner/overview', (route) =>
    fulfill(route, {
      data: {
        partner: { ...partnerInfo, status: 'active' },
        role,
        contract,
        workspaceCount: 1,
        activeWorkspaceCount: 1,
        currentMonth: { totalResale: '400.00', totalDue: '300.00', totalMargin: '100.00', currency: 'USD' },
        nearCreditLimit: [],
      },
    }),
  );
  await page.route(/\/api\/partner\/workspaces(\?.*)?$/, (route) =>
    fulfill(route, {
      data: [workspaceRow],
      pagination: { totalCount: 1, hasMore: false, cursor: null },
    }),
  );
  await page.route('**/api/partner/catalog', (route) =>
    fulfill(route, {
      data: {
        apps: [
          { code: 'welddesk', name: 'WeldDesk', icon: 'LifeBuoy' },
          { code: 'weldcrm', name: 'WeldCRM', icon: 'Users' },
        ],
        featurePlans: [],
      },
    }),
  );
  await page.route(/\/api\/partner\/packages(\?.*)?$/, (route) => fulfill(route, { data: [] }));
}

test.describe('Partner portal', () => {
  test('tells a user who is not a partner so, instead of an empty shell', async ({ page }) => {
    await mockPartnerApi(page, []);
    await page.goto('/partner');
    await expect(page.getByText('This account is not a partner')).toBeVisible({ timeout: 15_000 });
  });

  test('shows the overview with this month’s money for an owner', async ({ page }) => {
    await mockPartnerApi(page, [{ role: 'owner' }]);
    await page.goto('/partner');

    await expect(page.getByRole('heading', { name: 'Acme Partner' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Customers pay you')).toBeVisible();
    await expect(page.getByText('$400.00')).toBeVisible();
    await expect(page.getByText('$300.00')).toBeVisible();
    await expect(page.getByText('WeldSuite share: 75%')).toBeVisible();
  });

  test('lists the workspaces and previews what WeldSuite bills in the New workspace dialog', async ({ page }) => {
    await mockPartnerApi(page, [{ role: 'admin' }]);
    await page.goto('/partner/workspaces');

    const row = page.getByRole('row', { name: /Acme Industries/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('$400.00 flat');

    await page.getByRole('button', { name: 'New workspace' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    await dialog.getByLabel('Amount (USD)').fill('400');
    // 75% of $400 = $300 beats the $50 minimum.
    await expect(dialog.getByTestId('preview-due')).toHaveText('$300.00');
    await expect(dialog.getByTestId('preview-margin')).toHaveText('$100.00');

    await dialog.getByLabel('Amount (USD)').fill('60');
    // 75% of $60 = $45 is below the minimum: WeldSuite bills $50, the partner keeps $10.
    await expect(dialog.getByTestId('preview-due')).toHaveText('$50.00');
    await expect(dialog.getByTestId('preview-margin')).toHaveText('$10.00');
  });

  test('does not offer a viewer any way to create or change a workspace', async ({ page }) => {
    await mockPartnerApi(page, [{ role: 'viewer' }]);
    await page.goto('/partner/workspaces');

    await expect(page.getByRole('row', { name: /Acme Industries/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'New workspace' })).toHaveCount(0);
    // Statements need billing access, so the tab is not offered either.
    await expect(page.getByRole('link', { name: 'Statements' })).toHaveCount(0);
  });

  test('warns a past-due partner and links to the statements', async ({ page }) => {
    await mockPartnerApi(page, [{ role: 'owner', status: 'past_due' }]);
    await page.goto('/partner');
    const banner = page.getByRole('alert').filter({ hasText: 'Your WeldSuite payment is overdue' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner.getByRole('link', { name: 'View statements' })).toBeVisible();
  });
});
