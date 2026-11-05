import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import WeldMergeInboxPage from './page';
import { makeAssignedIssue, makeReviewRequest } from './test-fixtures';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  can: true,
  inbox: { isLoading: false, isError: false, data: [] as unknown[], refetch: vi.fn() },
  connections: { isSuccess: true, data: [{ id: 'mcn_1' }] as unknown[] },
  accounts: { isSuccess: true, data: { github: 'octocat' as string | null } },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can, useCanAny: () => state.can }));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  useMergeInbox: () => state.inbox,
  useMergeConnections: () => state.connections,
  useMyMergeAccounts: () => state.accounts,
  useUpdateMyMergeAccounts: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./lib/use-members', () => ({
  useMergeMembers: () => ({ members: [], memberById: new Map(), currentUserId: 'user_1' }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe('WeldMerge inbox', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.can = true;
    state.inbox = { isLoading: false, isError: false, data: [], refetch: vi.fn() };
    state.connections = { isSuccess: true, data: [{ id: 'mcn_1' }] };
    state.accounts = { isSuccess: true, data: { github: 'octocat' } };
  });

  it('lists what needs the member and previews the selected item', () => {
    state.inbox.data = [makeReviewRequest(), makeAssignedIssue()];
    render(<WeldMergeInboxPage />);
    expect(screen.getByRole('heading', { name: en.weldmerge.inbox.title })).toBeTruthy();
    expect(screen.getByText('feat(weldflow): tab visibility per project')).toBeTruthy();
    expect(screen.getByText('Webhook retries drop events')).toBeTruthy();
    expect(screen.getByText(en.weldmerge.inbox.selectItem)).toBeTruthy();

    fireEvent.click(screen.getByText('feat(weldflow): tab visibility per project'));
    expect(screen.getByText(en.weldmerge.inbox.why.review_requested)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldmerge.inbox.openPullRequest }).getAttribute('href')).toBe('/weldmerge/pull-requests/mpr_1');
    expect(screen.getByRole('link', { name: /Open on GitHub/ }).getAttribute('href')).toBe('https://github.com/weldsuite/weldsuite/pull/1466');
  });

  it('opens an assigned issue from its preview', () => {
    state.inbox.data = [makeAssignedIssue()];
    render(<WeldMergeInboxPage />);
    fireEvent.click(screen.getByText('Webhook retries drop events'));
    expect(screen.getByText(en.weldmerge.inbox.why.assigned)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldmerge.inbox.openIssue }).getAttribute('href')).toBe('/weldmerge/issues/API-97');
  });

  it('points to the git providers when nothing is connected', () => {
    state.connections = { isSuccess: true, data: [] };
    render(<WeldMergeInboxPage />);
    expect(screen.getByText(en.weldmerge.inbox.noConnectionTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldmerge.inbox.openProviders }).getAttribute('href')).toBe('/weldmerge/settings');
  });

  it('shows the empty state when connected and nothing needs the member', () => {
    render(<WeldMergeInboxPage />);
    expect(screen.getByText(en.weldmerge.inbox.emptyTitle)).toBeTruthy();
  });

  it('asks for a GitHub username when the member has none', () => {
    state.accounts = { isSuccess: true, data: { github: null } };
    render(<WeldMergeInboxPage />);
    expect(screen.getByText(en.weldmerge.inbox.usernameTitle)).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('does not ask for a username when it is set', () => {
    render(<WeldMergeInboxPage />);
    expect(screen.queryByText(en.weldmerge.inbox.usernameTitle)).toBeNull();
  });

  it('shows an error with a retry when the inbox fails to load', () => {
    state.inbox = { isLoading: false, isError: true, data: [], refetch: vi.fn() };
    render(<WeldMergeInboxPage />);
    expect(screen.getByText(en.weldmerge.loadFailed)).toBeTruthy();
  });

  it('renders in Dutch', () => {
    state.locale = 'nl';
    state.inbox.data = [makeReviewRequest()];
    render(<WeldMergeInboxPage />);
    expect(screen.getByText(nl.weldmerge.inbox.description)).toBeTruthy();
    expect(screen.getByText(new RegExp(nl.weldmerge.inbox.kinds.review_requested))).toBeTruthy();
  });
});
