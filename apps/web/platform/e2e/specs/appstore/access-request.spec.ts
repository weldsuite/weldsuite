/**
 * App Store — apps that are on request only (WeldReach).
 *
 * Instead of "Install", an app with `requiresApproval` shows "Request access"
 * to an owner/admin, then its state: pending, rejected (with the reason),
 * suspended. The request form carries the company details, target countries
 * and every term ticked one by one.
 *
 * The catalog and the access-request endpoints (app-api `/api/app-catalog/...`)
 * are mocked at the network layer, so the spec is deterministic and never files
 * a real request in the shared test workspace.
 */

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

type AccessStatus = 'none' | 'requested' | 'rejected' | 'suspended' | 'approved';

interface ReachMock {
  /** Access state served for the workspace. */
  status: AccessStatus;
  /** Bodies of the access-request POSTs. */
  requests: Array<Record<string, unknown>>;
}

const REACH_APP = {
  code: 'weldreach',
  name: 'WeldReach',
  description: 'Cold email outreach from dedicated mailboxes.',
  icon: '',
  category: 'Sales & Marketing',
  provider: 'WeldSuite',
  verified: true,
  isInstalled: false,
  overview: null,
  features: [],
  version: '1.0.0',
  releasedAt: null,
  websiteUrl: null,
  documentationUrl: null,
  contactUrl: null,
  requiresApproval: true,
};

function accessView(status: AccessStatus) {
  if (status === 'none') return null;
  return {
    appCode: 'weldreach',
    status,
    request: null,
    limits: {},
    rejectionReason: status === 'rejected' ? 'Please add your company registration number.' : null,
    suspendedReason: status === 'suspended' ? 'Complaint rate above the limit.' : null,
    requestedAt: '2026-10-10T12:00:00.000Z',
    reviewedAt: null,
  };
}

/** Serve the catalog (with the access state) and the access-request endpoints. Call BEFORE `page.goto()`. */
async function mockReachAccess(page: Page, initial: AccessStatus): Promise<ReachMock> {
  const state: ReachMock = { status: initial, requests: [] };
  const json = (route: Route, status: number, data: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

  await page.route('**/app-catalog**', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return route.continue();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');

    if (path === '/app-catalog' && req.method() === 'GET') {
      return json(route, 200, { data: [{ ...REACH_APP, accessStatus: state.status }] });
    }
    if (path === '/app-catalog/categories' && req.method() === 'GET') {
      return json(route, 200, { data: [REACH_APP.category] });
    }
    if (path === '/app-catalog/weldreach/access-request') {
      if (req.method() === 'GET') return json(route, 200, { data: accessView(state.status) });
      if (req.method() === 'POST') {
        state.requests.push(req.postDataJSON() as Record<string, unknown>);
        state.status = 'requested';
        return json(route, 201, { data: accessView('requested') });
      }
    }
    return route.continue();
  });

  await page.route('**/appstore/can-manage-apps', (route) => {
    const type = route.request().resourceType();
    if (type !== 'fetch' && type !== 'xhr') return route.continue();
    return json(route, 200, { data: { canManage: true } });
  });

  return state;
}

const card = (page: Page) => page.locator('a[href$="/appstore/weldreach"]');

async function openStore(page: Page) {
  await page.goto('/appstore');
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
}

test.describe('App Store · on-request app', () => {
  test('offers Request access instead of Install', async ({ page }) => {
    await mockReachAccess(page, 'none');
    await openStore(page);

    await expect(card(page).getByText('On request', { exact: true })).toBeVisible();
    await card(page).hover();
    await expect(card(page).getByRole('button', { name: 'Request access' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  });

  test('the form refuses an empty request and says what is missing', async ({ page }) => {
    const mock = await mockReachAccess(page, 'none');
    await openStore(page);

    await card(page).hover();
    await card(page).getByRole('button', { name: 'Request access' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request access to WeldReach' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(dialog.getByText('This field is required.').first()).toBeVisible();
    await expect(dialog.getByText('Tick every statement to continue.')).toBeVisible();
    expect(mock.requests).toHaveLength(0);
  });

  test('files a request with the terms version, then shows it as pending', async ({ page }) => {
    const mock = await mockReachAccess(page, 'none');
    await openStore(page);

    await card(page).hover();
    await card(page).getByRole('button', { name: 'Request access' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request access to WeldReach' });

    await dialog.getByLabel('Company legal name').fill('Acme B.V.');
    await dialog.getByLabel('Website').fill('https://acme.test');
    await dialog.getByLabel('Contact person').fill('Anna de Vries');
    await dialog.getByLabel('Contact email').fill('anna@acme.test');
    await dialog.getByLabel('What will you use WeldReach for?').fill('We sell payroll software to Dutch accountants.');
    await dialog.getByLabel('Expected emails per day').fill('150');

    // Netherlands needs prior consent, so the notice appears.
    await dialog.getByRole('combobox', { name: 'Countries you will email' }).fill('Nether');
    await page.getByRole('option', { name: 'Netherlands' }).click();
    await expect(dialog.getByText(/requires prior consent/)).toBeVisible();

    for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.click();
    await dialog.getByRole('button', { name: 'Send request' }).click();

    await expect(dialog).toBeHidden();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({
      companyName: 'Acme B.V.',
      targetCountries: ['NL'],
      expectedDailySends: 150,
      termsVersion: 'weldreach-2026-10',
    });
    expect(mock.requests[0].termsAccepted).toHaveLength(6);

    // The tile now shows the pending state and no longer offers a request.
    await expect(card(page).getByText('Request pending', { exact: true })).toBeVisible();
    await card(page).hover();
    await expect(card(page).getByRole('button', { name: /Request/ })).toHaveCount(0);
  });

  test('the detail page explains a pending request', async ({ page }) => {
    await mockReachAccess(page, 'requested');
    await page.goto('/appstore/weldreach');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText('Request pending', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/being reviewed/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Request access|Install/ })).toHaveCount(0);
  });

  test('the detail page shows why a request was rejected and offers to request again', async ({ page }) => {
    await mockReachAccess(page, 'rejected');
    await page.goto('/appstore/weldreach');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText('Your request was not approved')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Please add your company registration number/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request again' })).toBeVisible();
  });

  test('the detail page shows a suspension with its reason', async ({ page }) => {
    await mockReachAccess(page, 'suspended');
    await page.goto('/appstore/weldreach');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText('WeldReach is suspended for this workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Complaint rate above the limit/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Request/ })).toHaveCount(0);
  });
});
