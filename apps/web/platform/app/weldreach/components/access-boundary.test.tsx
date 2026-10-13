import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { ReachAccessSummary } from '@weldsuite/app-api-client/schemas/reach';
import { WELDREACH_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  reach: { access: vi.fn() },
  appAccess: { get: vi.fn() },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { ReachAccessBoundary } from './access-boundary';

const summary: ReachAccessSummary = {
  status: 'approved',
  limits: { ...WELDREACH_DEFAULT_LIMITS, maxMailboxes: 10, maxDomains: 3, maxDailySends: 300 },
  usage: { domains: 1, mailboxes: 4, sendsToday: 120 },
  sendingEnabled: true,
};

function refusal(status: string) {
  return new ApiError('refused', 403, {
    error: { code: 'APP_ACCESS_REQUIRED', message: 'refused', details: { appCode: 'weldreach', status } },
  });
}

function renderBoundary(client = // The access hook retries transient failures itself; no delay keeps that quick in tests.
  new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })) {
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReachAccessBoundary>
          <p>the page</p>
        </ReachAccessBoundary>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  api.reach.access.mockReset();
  api.appAccess.get.mockReset();
  api.appAccess.get.mockResolvedValue({ data: null });
});

afterEach(cleanup);

describe('ReachAccessBoundary', () => {
  it('shows the page with usage against the limits once access is approved', async () => {
    api.reach.access.mockResolvedValue({ data: summary });
    renderBoundary();

    expect(await screen.findByText('the page')).toBeInTheDocument();
    expect(screen.getByText('4 of 10')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('120 of 300')).toBeInTheDocument();
    expect(screen.queryByText('Sending is temporarily switched off')).not.toBeInTheDocument();
  });

  it('warns when sending is switched off for everyone, and still shows the page', async () => {
    api.reach.access.mockResolvedValue({ data: { ...summary, sendingEnabled: false } });
    renderBoundary();

    expect(await screen.findByText('Sending is temporarily switched off')).toBeInTheDocument();
    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('explains a pending request instead of the page', async () => {
    api.reach.access.mockRejectedValue(refusal('requested'));
    renderBoundary();

    expect(await screen.findByText('Your request is being reviewed')).toBeInTheDocument();
    expect(screen.queryByText('the page')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View your request' })).toHaveAttribute('href', '/appstore/weldreach');
  });

  it('explains a suspension with the staff-written reason', async () => {
    api.reach.access.mockRejectedValue(refusal('suspended'));
    api.appAccess.get.mockResolvedValue({ data: { status: 'suspended', suspendedReason: 'Too many complaints' } });
    renderBoundary();

    expect(await screen.findByText('WeldReach is suspended for this workspace')).toBeInTheDocument();
    expect(await screen.findByText(/Too many complaints/)).toBeInTheDocument();
  });

  it('shows the rejection reason for a rejected request', async () => {
    api.reach.access.mockRejectedValue(refusal('rejected'));
    api.appAccess.get.mockResolvedValue({ data: { status: 'rejected', rejectionReason: 'Lists look bought' } });
    renderBoundary();

    expect(await screen.findByText('Your request was not approved')).toBeInTheDocument();
    expect(await screen.findByText(/Lists look bought/)).toBeInTheDocument();
  });

  it('offers a retry when the access check fails for another reason', async () => {
    api.reach.access.mockRejectedValue(new ApiError('boom', 500, { error: { code: 'INTERNAL' } }));
    renderBoundary();

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('the page')).not.toBeInTheDocument();
  });

  it('flips to the explanation as soon as any reach query is refused mid-session', async () => {
    api.reach.access.mockResolvedValueOnce({ data: summary });
    const client = renderBoundary();
    expect(await screen.findByText('the page')).toBeInTheDocument();

    // Staff suspend the workspace; the next reach call is refused, and the access check follows.
    api.reach.access.mockRejectedValue(refusal('suspended'));
    await client
      .fetchQuery({ queryKey: ['reach', 'mailboxes', {}], queryFn: () => Promise.reject(refusal('suspended')) })
      .catch(() => undefined);

    expect(await screen.findByText('WeldReach is suspended for this workspace')).toBeInTheDocument();
    expect(screen.queryByText('the page')).not.toBeInTheDocument();
  });
});
