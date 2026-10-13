/**
 * WeldReach shell, overview, mailboxes & domains and the blocked states.
 *
 * reach-api is mocked at the network layer (`/api/reach/*`), so the spec needs
 * no approved workspace and never creates a real mailbox (which costs money).
 * WeldReach is made to look installed through the installed-apps response, the
 * same way the WeldData spec does.
 */

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

const INSTALLED_APPS = ['weldreach', 'weldcrm', 'weldhost', 'weldmail', 'weldchat', 'weldcalendar', 'welddrive'];

const NOW = '2026-10-12T10:00:00.000Z';

const ACCESS = {
  status: 'approved',
  limits: { maxDomains: 3, maxMailboxes: 10, maxDailySends: 300, allowConsumerRecipients: false, forceAllowDomains: [] },
  usage: { domains: 1, mailboxes: 2, sendsToday: 40 },
  sendingEnabled: true,
};

const OVERVIEW = {
  sentToday: 40,
  sent7d: 310,
  replies7d: 21,
  interested7d: 4,
  bounceRate7d: 0.012,
  replyRate7d: 0.068,
  activeCampaigns: 2,
  mailboxes: { active: 1, warming: 1, paused: 0, error: 0 },
  unreadReplies: 3,
  daily: Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 9, i - 1)).toISOString().slice(0, 10),
    sent: 20 + i,
    replies: i % 4,
  })),
};

const SETTINGS = {
  id: 'rs_1',
  senderCompanyName: 'Acme B.V.',
  senderAddress: 'Street 1, 1234 AB Amsterdam',
  optOutText: 'Reply "stop" to opt out.',
  defaultTimezone: 'Europe/Amsterdam',
  defaultSendDays: [1, 2, 3, 4, 5],
  defaultWindowStart: '09:00',
  defaultWindowEnd: '17:00',
  defaultMailboxDailyCap: 30,
  stopOnReplyScope: 'prospect',
  onboardingCompletedAt: '2026-10-05T00:00:00.000Z',
};

const DOMAIN = {
  id: 'rdm_1',
  hostDomainId: 'dom_1',
  name: 'getacme.com',
  mailpoolDomainId: 'mp_1',
  status: 'active',
  dnsStatus: { spf: true, dkim: true, dmarc: false, mx: true, checkedAt: NOW },
  dmarcPolicy: null,
  connectedAt: NOW,
  lastError: null,
  mailboxCount: 2,
  createdAt: NOW,
};

function mailbox(id: string, first: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    domainId: 'rdm_1',
    domainName: 'getacme.com',
    email: `${first.toLowerCase()}@getacme.com`,
    firstName: first,
    lastName: 'Tester',
    signature: null,
    type: 'shared',
    status,
    warmupDay: 14,
    warmupStatus: null,
    warmupInboxRate: 0.92,
    warmupSent7d: 70,
    warmupSpamRescues7d: 2,
    warmupBlocker: null,
    dailyCap: 30,
    rampCurrent: 20,
    sentToday: 12,
    lastSentAt: NOW,
    pausedReason: null,
    lastError: null,
    createdAt: NOW,
    ...extra,
  };
}

const list = (data: unknown[]) => ({ data, pagination: { totalCount: data.length, hasMore: false, cursor: null } });
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface ReachMock {
  /** Paths (method + path) the page called, in order. */
  calls: string[];
}

async function mockReach(page: Page, options: { accessStatus?: string } = {}): Promise<ReachMock> {
  const state: ReachMock = { calls: [] };

  await page.route('**/dashboard/installed-apps**', (route) => json(route, 200, { data: INSTALLED_APPS }));

  // The staff-written reason for a blocked workspace lives in app-api.
  await page.route('**/app-catalog/weldreach/access-request', (route) =>
    json(route, 200, {
      data: {
        appCode: 'weldreach',
        status: options.accessStatus ?? 'approved',
        request: null,
        limits: {},
        rejectionReason: null,
        suspendedReason: 'Complaint rate above the limit.',
        requestedAt: NOW,
        reviewedAt: null,
      },
    }),
  );

  await page.route('**/api/reach/**', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return route.continue();
    const path = new URL(req.url()).pathname.replace(/^\/api\/reach/, '');
    state.calls.push(`${req.method()} ${path}`);

    if (options.accessStatus && options.accessStatus !== 'approved') {
      return json(route, 403, {
        error: {
          code: 'APP_ACCESS_REQUIRED',
          message: 'no access',
          details: { appCode: 'weldreach', status: options.accessStatus },
        },
      });
    }

    if (path === '/access') return json(route, 200, { data: ACCESS });
    if (path === '/overview') return json(route, 200, { data: OVERVIEW });
    if (path === '/settings') return json(route, 200, { data: SETTINGS });
    if (path === '/domains') return json(route, 200, list([DOMAIN]));
    if (path === '/domains/candidates') return json(route, 200, list([]));
    if (path.startsWith('/mailboxes') && req.method() === 'GET') {
      return json(route, 200, list([mailbox('rmb_1', 'Anna', 'active'), mailbox('rmb_2', 'Ben', 'warming', { warmupDay: 6, sentToday: 0 })]));
    }
    if (path.startsWith('/mailboxes') && req.method() === 'POST') {
      return json(route, 402, { error: { code: 'PAYMENT_METHOD_REQUIRED', message: 'Payment method required' } });
    }
    return route.continue();
  });

  return state;
}

test.describe('WeldReach · overview', () => {
  test('shows the numbers, the usage header and the sidebar sections', async ({ page }) => {
    await mockReach(page);
    await page.goto('/weldreach');

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Sent today', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('of 300 allowed per day')).toBeVisible();
    await expect(page.getByText('Unread replies')).toBeVisible();
    // Usage against the workspace's limits, above every page of the module.
    await expect(page.getByText('2 of 10')).toBeVisible();

    const sidebar = page.getByTestId('app-sidebar');
    for (const label of ['Campaigns', 'Prospects', 'Inbox', 'Mailboxes & domains', 'Settings']) {
      await expect(sidebar.getByRole('link', { name: label })).toBeVisible();
    }
  });
});

test.describe('WeldReach · mailboxes & domains', () => {
  test('lists the domain with its DNS checks and the mailboxes with warmup progress', async ({ page }) => {
    await mockReach(page);
    await page.goto('/weldreach/mailboxes');

    await expect(page.getByRole('heading', { name: 'Mailboxes & domains' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('getacme.com', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('SPF is in place')).toBeAttached();
    await expect(page.getByText('DMARC is missing or wrong')).toBeAttached();
    await expect(page.getByText('anna@getacme.com')).toBeVisible();
    await expect(page.getByText('Day 6 of 14')).toBeVisible();
  });

  test('turns a 402 on mailbox creation into a prompt to add a payment method', async ({ page }) => {
    await mockReach(page);
    await page.goto('/weldreach/mailboxes');
    await expect(page.getByText('anna@getacme.com')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'New mailbox' }).click();
    const dialog = page.getByRole('dialog', { name: 'New mailbox' });
    await dialog.getByLabel('Address').fill('carla');
    await dialog.getByLabel('First name').fill('Carla');
    await dialog.getByLabel('Last name').fill('Smit');
    await dialog.getByRole('button', { name: 'Create mailbox' }).click();

    await expect(dialog.getByText('Add a payment method first')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add payment method' })).toBeVisible();
  });
});

test.describe('WeldReach · blocked workspace', () => {
  test('explains a suspension, with the reason, instead of the page', async ({ page }) => {
    await mockReach(page, { accessStatus: 'suspended' });
    await page.goto('/weldreach');

    await expect(page.getByText('WeldReach is suspended for this workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Complaint rate above the limit/)).toBeVisible();
    await expect(page.getByText('Sent today', { exact: true })).toHaveCount(0);
  });
});
