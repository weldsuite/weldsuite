import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReachThreadSummary } from '@weldsuite/app-api-client/schemas/reach';
import {
  messageFixture,
  page,
  renderWithApp,
  stubRadixBrowserApis,
  threadFixture,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  listThreads: vi.fn(),
  unreadCount: vi.fn(),
  listCampaigns: vi.fn(),
  listMailboxes: vi.fn(),
  getThread: vi.fn(),
  updateMessage: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
vi.mock('@/hooks/use-user-idle', () => ({ useIdleAwareRefetchInterval: () => false }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), search: '' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(router.search),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ReachInboxPage from './page';

function summary(key: string, overrides: Partial<ReachThreadSummary> = {}): ReachThreadSummary {
  return {
    ...threadFixture([messageFixture(`msg_${key}`, { threadKey: key })], { threadKey: key }).summary,
    threadKey: key,
    ...overrides,
  };
}

const unreadThread = summary('thr_unread');
const readThread = summary('thr_read', {
  prospect: {
    id: 'prs_2',
    email: 'bo@widgets.nl',
    firstName: 'Bo',
    lastName: 'Smit',
    companyName: 'Widgets',
    personId: null,
  },
  lastInbound: {
    ...unreadThread.lastInbound,
    id: 'msg_read',
    subject: 'Re: Pricing',
    snippet: 'Can you send the price list?',
    readAt: '2026-10-12T10:05:00Z',
    label: 'meeting_request',
  },
});

function lastThreadFilters() {
  return reach.listThreads.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  router.search = '';
  reach.listThreads.mockResolvedValue(page([unreadThread, readThread]));
  reach.unreadCount.mockResolvedValue({ data: { count: 3 } });
  reach.listCampaigns.mockResolvedValue(
    page([{ id: 'cmp_1', name: 'Q4 outreach' }, { id: 'cmp_2', name: 'Events' }]),
  );
  reach.listMailboxes.mockResolvedValue(
    page([{ id: 'mbx_1', email: 'sam@outreach.example' }, { id: 'mbx_2', email: 'kim@outreach.example' }]),
  );
  reach.updateMessage.mockResolvedValue({ data: messageFixture('msg_x') });
});

describe('Reply inbox', () => {
  it('lists conversations with who wrote, the label and the unread count', async () => {
    renderWithApp(<ReachInboxPage />);

    expect(await screen.findByText('Ana Jansen')).toBeInTheDocument();
    expect(screen.getByText('Bo Smit')).toBeInTheDocument();
    expect(screen.getByText('Can you send the price list?')).toBeInTheDocument();
    expect(screen.getByText('Meeting request')).toBeInTheDocument();
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Unread\s*3/ })).toBeInTheDocument();
  });

  it('starts on the open conversations and filters by state on the server', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachInboxPage />);
    await screen.findByText('Ana Jansen');

    expect(lastThreadFilters()).toMatchObject({ state: 'open' });
    await user.click(screen.getByRole('tab', { name: /Handled/ }));

    await waitFor(() => expect(lastThreadFilters()).toMatchObject({ state: 'handled' }));
  });

  it('filters by label, campaign and mailbox on the server', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachInboxPage />);
    await screen.findByText('Ana Jansen');

    await user.click(screen.getByRole('combobox', { name: 'Filter by label' }));
    await user.click(await screen.findByRole('option', { name: 'Interested' }));
    await waitFor(() => expect(lastThreadFilters()).toMatchObject({ label: 'interested' }));

    await user.click(screen.getByRole('combobox', { name: 'Filter by campaign' }));
    await user.click(await screen.findByRole('option', { name: 'Events' }));
    await waitFor(() => expect(lastThreadFilters()).toMatchObject({ label: 'interested', campaignId: 'cmp_2' }));

    await user.click(screen.getByRole('combobox', { name: 'Filter by mailbox' }));
    await user.click(await screen.findByRole('option', { name: 'kim@outreach.example' }));
    await waitFor(() =>
      expect(lastThreadFilters()).toMatchObject({ label: 'interested', campaignId: 'cmp_2', mailboxId: 'mbx_2' }),
    );
  });

  it('opens a conversation by putting its key in the address', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachInboxPage />);

    await user.click(await screen.findByRole('button', { name: /Bo Smit/ }));

    expect(router.replace).toHaveBeenCalledWith('/weldreach/inbox?thread=thr_read');
  });

  it('shows the conversation named in the address next to the list', async () => {
    router.search = 'thread=thr_unread';
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { threadKey: 'thr_unread' })], { threadKey: 'thr_unread' }),
    });
    renderWithApp(<ReachInboxPage />);

    const article = await screen.findByRole('article');
    expect(within(article).getByText('Sounds interesting, tell me more.')).toBeInTheDocument();
    expect(reach.getThread).toHaveBeenCalledWith('thr_unread');
    // The opened thread is marked in the list.
    expect(screen.getAllByRole('button', { name: /Ana Jansen/ })[0]).toHaveAttribute('aria-current', 'true');
  });

  it('says so when there is nothing to handle', async () => {
    reach.listThreads.mockResolvedValue(page([]));
    renderWithApp(<ReachInboxPage />);

    expect(await screen.findByText('No replies to handle')).toBeInTheDocument();
  });

  it('shows the error when the inbox cannot be loaded', async () => {
    reach.listThreads.mockRejectedValue(new Error('Reply inbox is unavailable.'));
    renderWithApp(<ReachInboxPage />);

    expect(await screen.findByText('Reply inbox is unavailable.')).toBeInTheDocument();
  });
});
