import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeIssue, makePullRequest } from '@/app/weldmerge/test-fixtures';
import { MessageWeldMergeCard } from './message-weldmerge-card';

const state = vi.hoisted(() => ({
  can: {} as Record<string, boolean>,
  issue: { isLoading: false, data: undefined as unknown },
  pullRequest: { isLoading: false, data: undefined as unknown },
  release: { isLoading: false, data: undefined as unknown },
  approve: vi.fn(),
  snooze: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.can[key] === true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/api-client', () => ({ isApiError: (err: unknown) => (err as { isApi?: boolean })?.isApi === true }));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  useMergeIssue: () => state.issue,
  useMergePullRequest: () => state.pullRequest,
}));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useMergeRelease: () => state.release,
  useApproveMergePullRequest: () => ({ mutateAsync: state.approve, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldmerge-sync-queries', () => ({
  useUpdateMergeInboxItem: () => ({ mutateAsync: state.snooze, isPending: false }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const message = (weldmerge: unknown) => ({ metadata: { weldmerge } });

beforeEach(() => {
  state.can = {
    'merge_issues:read': true,
    'merge_pull_requests:read': true,
    'merge_pull_requests:review': true,
    'merge_releases:read': true,
  };
  state.issue = { isLoading: false, data: makeIssue() };
  state.pullRequest = { isLoading: false, data: makePullRequest() };
  state.release = {
    isLoading: false,
    data: { id: 'mrl_1', name: 'Spring release', version: 'v1.4.0', repositoryFullName: 'acme/api', pullRequestCount: 4 },
  };
  state.approve = vi.fn().mockResolvedValue({});
  state.snooze = vi.fn().mockResolvedValue({});
});

describe('MessageWeldMergeCard', () => {
  it('renders nothing for an ordinary message', () => {
    const { container } = render(<MessageWeldMergeCard message={{ metadata: { approvals: [] } }} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a review request with Approve and Snooze', async () => {
    render(<MessageWeldMergeCard message={message({ kind: 'review_requested', pullRequestId: 'mpr_1', itemKey: 'review_requested:mpr_1' })} />);
    expect(screen.getByText(en.weldmerge.across.chat.kind.review_requested)).toBeTruthy();
    expect(screen.getByText('feat(weldflow): tab visibility per project')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.chat.approve }));
    await waitFor(() => expect(state.approve).toHaveBeenCalledWith({ id: 'mpr_1' }));
    expect(await screen.findByRole('button', { name: en.weldmerge.across.chat.approved })).toBeTruthy();
  });

  it('snoozes the inbox item until tomorrow', async () => {
    render(<MessageWeldMergeCard message={message({ kind: 'review_requested', pullRequestId: 'mpr_1', itemKey: 'review_requested:mpr_1' })} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.chat.snooze) }));
    await waitFor(() => expect(state.snooze).toHaveBeenCalled());
    const call = state.snooze.mock.calls[0]?.[0] as { itemKey: string; input: { snoozedUntil: string } };
    expect(call.itemKey).toBe('review_requested:mpr_1');
    const hours = (Date.parse(call.input.snoozedUntil) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
  });

  it('offers no review actions without merge_pull_requests:review, but still links to the pull request', () => {
    state.can['merge_pull_requests:review'] = false;
    render(<MessageWeldMergeCard message={message({ kind: 'review_requested', pullRequestId: 'mpr_1', itemKey: 'k' })} />);
    expect(screen.queryByRole('button', { name: en.weldmerge.across.chat.approve })).toBeNull();
    expect(screen.getByRole('link', { name: en.weldmerge.across.chat.open }).getAttribute('href')).toBe('/weldmerge/pull-requests/mpr_1');
  });

  it('explains when the account is not linked', async () => {
    const { toast } = await import('sonner');
    state.approve = vi.fn().mockRejectedValue({ isApi: true, status: 409 });
    render(<MessageWeldMergeCard message={message({ kind: 'review_requested', pullRequestId: 'mpr_1', itemKey: 'k' })} />);
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.chat.approve }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.weldmerge.across.chat.notLinked));
  });

  it('shows a merged pull request without actions', () => {
    state.pullRequest.data = makePullRequest({ state: 'merged' });
    render(<MessageWeldMergeCard message={message({ kind: 'pull_request_merged', pullRequestId: 'mpr_1' })} />);
    expect(screen.getByText(en.weldmerge.across.chat.kind.pull_request_merged)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.weldmerge.across.chat.approve })).toBeNull();
  });

  it('shows an issue card that opens the issue', () => {
    render(<MessageWeldMergeCard message={message({ kind: 'issue_done', issueId: 'mis_1' })} />);
    expect(screen.getByText('Tab visibility per project')).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldmerge.across.chat.open }).getAttribute('href')).toBe('/weldmerge/issues/PLAT-209');
  });

  it('shows a shipped release', () => {
    render(<MessageWeldMergeCard message={message({ kind: 'release_shipped', releaseId: 'mrl_1' })} />);
    expect(screen.getByText('Spring release v1.4.0')).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldmerge.across.chat.open }).getAttribute('href')).toBe('/weldmerge/releases/mrl_1');
  });

  it('links the daily digest to the inbox', () => {
    render(<MessageWeldMergeCard message={message({ kind: 'daily_digest' })} />);
    expect(screen.getByRole('link', { name: en.weldmerge.across.chat.digestOpen }).getAttribute('href')).toBe('/weldmerge');
  });

  it('says the item is gone when it cannot be loaded', () => {
    state.issue = { isLoading: false, data: undefined };
    render(<MessageWeldMergeCard message={message({ kind: 'issue_created', issueId: 'mis_gone' })} />);
    expect(screen.getByText(en.weldmerge.across.chat.notFound)).toBeTruthy();
  });

  it('shows nothing the viewer may not read', () => {
    state.can['merge_issues:read'] = false;
    const { container } = render(<MessageWeldMergeCard message={message({ kind: 'issue_created', issueId: 'mis_1' })} />);
    expect(container.firstChild).toBeNull();
  });
});
