import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { WELDREACH_DEFAULT_LIMITS, type ReachOverview, type ReachSettings } from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  reach: { overview: vi.fn(), access: vi.fn(), getSettings: vi.fn() },
}));
const permissions = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: permissions.can, isOwner: false }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// recharts needs layout that jsdom cannot give; the chart itself is not under test here.
vi.mock('./components/activity-chart', () => ({ ActivityChart: () => <div data-testid="activity-chart" /> }));

import ReachOverviewPage from './page';

function days(sent: number, replies: number): ReachOverview['daily'] {
  return Array.from({ length: 14 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    sent,
    replies,
  }));
}

const overview: ReachOverview = {
  sentToday: 120,
  sent7d: 800,
  replies7d: 40,
  interested7d: 6,
  bounceRate7d: 0.012,
  replyRate7d: 0.05,
  activeCampaigns: 3,
  mailboxes: { active: 4, warming: 2, paused: 1, error: 0 },
  unreadReplies: 7,
  daily: days(50, 3),
};

const settings: ReachSettings = {
  id: 'rs_1',
  senderCompanyName: 'Acme',
  senderAddress: 'Street 1',
  optOutText: 'stop',
  defaultTimezone: 'Europe/Amsterdam',
  defaultSendDays: [1, 2, 3, 4, 5],
  defaultWindowStart: '09:00',
  defaultWindowEnd: '17:00',
  defaultMailboxDailyCap: 30,
  stopOnReplyScope: 'prospect',
  onboardingCompletedAt: '2026-10-05T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReachOverviewPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api.reach)) fn.mockReset();
  permissions.can.mockReset();
  permissions.can.mockReturnValue(true);
  api.reach.overview.mockResolvedValue({ data: overview });
  api.reach.getSettings.mockResolvedValue({ data: settings });
  api.reach.access.mockResolvedValue({
    data: {
      status: 'approved',
      limits: { ...WELDREACH_DEFAULT_LIMITS, maxDailySends: 300 },
      usage: { domains: 1, mailboxes: 7, sendsToday: 120 },
      sendingEnabled: true,
    },
  });
});

afterEach(cleanup);

describe('Overview page', () => {
  it('shows today and the last week, with the limit next to today\'s sends', async () => {
    renderPage();

    expect(await screen.findByText('Sent today')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(await screen.findByText('of 300 allowed per day')).toBeInTheDocument();
    expect(screen.getByText('800')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('1.2%')).toBeInTheDocument();
    expect(screen.getByTestId('activity-chart')).toBeInTheDocument();
  });

  it('links unread replies and active campaigns to their pages', async () => {
    renderPage();

    const unread = (await screen.findByText('Unread replies')).closest('a');
    expect(unread).toHaveAttribute('href', '/weldreach/inbox');
    expect(screen.getByText('Active campaigns').closest('a')).toHaveAttribute('href', '/weldreach/campaigns');
  });

  it('does not link to pages the member cannot read', async () => {
    permissions.can.mockImplementation((key: string) => key === 'reach_settings:read');
    renderPage();

    const unread = await screen.findByText('Unread replies');
    expect(unread.closest('a')).toBeNull();
  });

  it('summarises mailbox health', async () => {
    renderPage();

    expect(await screen.findByText('Ready to send')).toBeInTheDocument();
    expect(screen.getByText('Warming up')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage mailboxes' })).toHaveAttribute('href', '/weldreach/mailboxes');
  });

  it('asks to add a first mailbox when there are none', async () => {
    api.reach.overview.mockResolvedValue({ data: { ...overview, mailboxes: { active: 0, warming: 0, paused: 0, error: 0 } } });
    renderPage();

    expect(await screen.findByText('No mailboxes yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a mailbox' })).toBeInTheDocument();
  });

  it('says so instead of drawing an empty chart', async () => {
    api.reach.overview.mockResolvedValue({ data: { ...overview, daily: days(0, 0) } });
    renderPage();

    expect(await screen.findByText('Nothing sent yet. Launch a campaign to see results here.')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-chart')).not.toBeInTheDocument();
  });

  it('flags a bounce rate above the guardrail', async () => {
    api.reach.overview.mockResolvedValue({ data: { ...overview, bounceRate7d: 0.045 } });
    renderPage();

    expect(await screen.findByText('Above 3%. Check your lists.')).toBeInTheDocument();
  });

  it('shows the setup card until onboarding is completed', async () => {
    api.reach.getSettings.mockResolvedValue({ data: { ...settings, onboardingCompletedAt: null } });
    renderPage();

    expect(await screen.findByText('Set up WeldReach')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start setup' })).toHaveAttribute('href', '/weldreach/setup');
  });

  it('does not show the setup card once onboarding is done, or to members who cannot change settings', async () => {
    renderPage();
    await screen.findByText('Sent today');
    expect(screen.queryByText('Set up WeldReach')).not.toBeInTheDocument();

    cleanup();
    api.reach.getSettings.mockResolvedValue({ data: { ...settings, onboardingCompletedAt: null } });
    permissions.can.mockImplementation((key: string) => key.endsWith(':read'));
    renderPage();
    await screen.findByText('Sent today');
    expect(screen.queryByText('Set up WeldReach')).not.toBeInTheDocument();
  });

  it('offers a retry when the numbers cannot be loaded', async () => {
    api.reach.overview.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
