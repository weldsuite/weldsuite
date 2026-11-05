import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { MergePullRequestFile, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import WeldMergePullRequestPage from './page';
import { makePullRequest } from '../../test-fixtures';

const FILE: MergePullRequestFile = {
  path: 'src/app/tabs.ts',
  previousPath: null,
  status: 'modified',
  additions: 2,
  deletions: 1,
  patch: ['@@ -1,3 +1,4 @@ export function tabs() {', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' return a;'].join('\n'),
};

const THREAD: MergeReviewThread = {
  id: 'thr_1',
  path: 'src/app/tabs.ts',
  line: 2,
  side: 'RIGHT',
  resolved: false,
  comments: [{ id: 'c1', body: 'Why three?', author: { login: 'sanne', avatarUrl: null }, createdAt: '2026-11-05T10:00:00.000Z', url: null }],
};

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  can: true,
  pr: null as unknown,
  files: [] as unknown[],
  threads: [] as unknown[],
  review: vi.fn(),
  comment: vi.fn(),
  merge: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can, useCanAny: () => state.can }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ pullRequestId: 'mpr_1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  useMergePullRequest: () => ({ isLoading: false, isError: false, data: state.pr, refetch: vi.fn() }),
  useLinkMergePullRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnlinkMergePullRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldmerge-review-queries', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/queries/use-weldmerge-review-queries')>()),
  useMergePullRequestFiles: () => ({ isLoading: false, isError: false, data: state.files, refetch: vi.fn() }),
  useMergePullRequestThreads: () => ({ isLoading: false, isError: false, data: state.threads, refetch: vi.fn() }),
  useSubmitMergeReview: () => ({ mutateAsync: state.review, isPending: false }),
  useCreateMergePullRequestComment: () => ({ mutateAsync: state.comment, isPending: false }),
  useMergePullRequestOnProvider: () => ({ mutateAsync: state.merge, isPending: false }),
}));
vi.mock('../../components/link-issue-popover', () => ({ LinkIssuePopover: () => null }));

const tr = en.weldmerge.reviewing;

function openFiles() {
  fireEvent.click(screen.getByRole('tab', { name: tr.tabs.files }));
}

/** Clicks the add-comment button of the n-th commentable line. */
function commentOnLine(index: number) {
  fireEvent.click(screen.getAllByRole('button', { name: tr.files.addComment })[index]);
}

describe('WeldMerge pull request review', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.can = true;
    state.pr = { ...makePullRequest(), body: 'Body text', headSha: 'abc', syncedAt: '2026-11-05T11:00:00.000Z' };
    state.files = [FILE];
    state.threads = [THREAD];
    state.review = vi.fn().mockResolvedValue({});
    state.comment = vi.fn().mockResolvedValue({});
    state.merge = vi.fn().mockResolvedValue({});
  });

  it('renders the files with counts, line numbers and the existing thread inline', () => {
    render(<WeldMergePullRequestPage />);
    expect(screen.getByText('Body text')).toBeTruthy();
    openFiles();
    expect(screen.getAllByText('tabs.ts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    expect(screen.getByText('const c = 4;')).toBeTruthy();
    expect(screen.getByText('Why three?')).toBeTruthy();
    expect(screen.getByText(tr.files.viewed)).toBeTruthy();
  });

  it('folds a file away when it is marked viewed', () => {
    render(<WeldMergePullRequestPage />);
    openFiles();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText('const c = 4;')).toBeNull();
  });

  it('sends pending line comments with the review', async () => {
    render(<WeldMergePullRequestPage />);
    openFiles();
    // Lines: context 1, removed 2 (LEFT), added 2, added 3, context 4. Comment on the first added line.
    commentOnLine(2);
    fireEvent.change(screen.getByPlaceholderText(tr.draft.placeholder), { target: { value: 'Prefer a constant' } });
    fireEvent.click(screen.getByRole('button', { name: tr.draft.addToReview }));
    expect(screen.getByText('Prefer a constant')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(tr.review.button) }));
    fireEvent.click(await screen.findByLabelText(new RegExp('^' + tr.review.requestChanges)));
    fireEvent.change(screen.getByLabelText(tr.review.summaryLabel), { target: { value: 'Needs work' } });
    fireEvent.click(screen.getByRole('button', { name: tr.review.submit }));

    await waitFor(() =>
      expect(state.review).toHaveBeenCalledWith({
        event: 'request_changes',
        body: 'Needs work',
        comments: [{ path: 'src/app/tabs.ts', line: 2, side: 'RIGHT', body: 'Prefer a constant' }],
      }),
    );
  });

  it('comments on a removed line against the left side', async () => {
    render(<WeldMergePullRequestPage />);
    openFiles();
    commentOnLine(1);
    fireEvent.change(screen.getByPlaceholderText(tr.draft.placeholder), { target: { value: 'Why remove?' } });
    fireEvent.click(screen.getByRole('button', { name: tr.draft.commentNow }));
    await waitFor(() =>
      expect(state.comment).toHaveBeenCalledWith({ body: 'Why remove?', path: 'src/app/tabs.ts', line: 2, side: 'LEFT' }),
    );
  });

  it('shows the not-linked notice with a link to the accounts settings', async () => {
    state.review = vi.fn().mockRejectedValue(Object.assign(new Error('Link your account'), { body: { error: { code: 'account_not_linked' } } }));
    render(<WeldMergePullRequestPage />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tr.review.button) }));
    fireEvent.click(await screen.findByLabelText(new RegExp('^' + tr.review.approve)));
    fireEvent.click(screen.getByRole('button', { name: tr.review.submit }));
    const link = await screen.findByRole('link', { name: tr.errors.linkAccount });
    expect(link.getAttribute('href')).toBe('/weldmerge/settings?tab=accounts');
  });

  it('merges after a confirmation, and blocks a draft with a reason', async () => {
    const view = render(<WeldMergePullRequestPage />);
    fireEvent.click(screen.getByRole('button', { name: tr.merge.button }));
    fireEvent.click(await screen.findByRole('button', { name: tr.merge.confirmLabel }));
    await waitFor(() => expect(state.merge).toHaveBeenCalledWith({ method: 'merge' }));
    view.unmount();

    state.pr = { ...makePullRequest({ draft: true }), body: null, headSha: null, syncedAt: '2026-11-05T11:00:00.000Z' };
    render(<WeldMergePullRequestPage />);
    expect(screen.getByText(tr.merge.disabled.draft)).toBeTruthy();
    expect((screen.getByRole('button', { name: tr.merge.button }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for a second confirmation wording when checks fail', async () => {
    state.pr = { ...makePullRequest({ checksStatus: 'failure' }), body: null, headSha: null, syncedAt: '2026-11-05T11:00:00.000Z' };
    render(<WeldMergePullRequestPage />);
    fireEvent.click(screen.getByRole('button', { name: tr.merge.button }));
    expect(await screen.findByText(tr.merge.confirmFailingChecks)).toBeTruthy();
    expect(screen.getByRole('button', { name: tr.merge.confirmAnyway })).toBeTruthy();
  });

  it('hides review and merge without the permissions', () => {
    state.can = false;
    render(<WeldMergePullRequestPage />);
    expect(screen.queryByRole('button', { name: new RegExp(tr.review.button) })).toBeNull();
    expect(screen.queryByRole('button', { name: tr.merge.button })).toBeNull();
    expect(screen.getByText(en.weldmerge.pullRequests.readOnlyNote)).toBeTruthy();
  });

  it('keeps resolved threads collapsed in the conversation and speaks Dutch', () => {
    state.locale = 'nl';
    state.threads = [{ ...THREAD, resolved: true }];
    render(<WeldMergePullRequestPage />);
    fireEvent.click(screen.getByRole('tab', { name: nl.weldmerge.reviewing.tabs.conversation }));
    expect(screen.getByText(nl.weldmerge.reviewing.conversation.showResolved)).toBeTruthy();
    expect(screen.queryByText(nl.weldmerge.reviewing.conversation.hideResolved)).toBeNull();
    fireEvent.click(screen.getByText(nl.weldmerge.reviewing.conversation.showResolved));
    expect(screen.getByText('Why three?')).toBeTruthy();
  });
});
