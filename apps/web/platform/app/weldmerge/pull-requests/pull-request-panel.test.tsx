import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { MergePullRequestFile, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { PullRequestPanel } from './pull-request-panel';
import { makePullRequest } from '../test-fixtures';
import { fill } from '../lib/format';

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
  can: true,
  pr: null as unknown,
  prError: null as unknown,
  files: [] as unknown[],
  threads: [] as unknown[],
  review: vi.fn(),
  comment: vi.fn(),
  merge: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can, useCanAny: () => state.can }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
// The chat composer, reduced to what the conversation hands it: a placeholder and the submit override.
vi.mock('@/app/weldchat/components/message-input', async () => {
  const { useState } = await import('react');
  return {
    MessageInput: ({
      placeholder,
      onSubmitOverride,
    }: {
      placeholder: string;
      onSubmitOverride: (payload: { content: string; mentions: string[]; attachments: unknown[] }) => Promise<void>;
    }) => {
      const [text, setText] = useState('');
      return (
        <div>
          <textarea aria-label={placeholder} value={text} onChange={(event) => setText(event.target.value)} />
          <button type="button" onClick={() => void onSubmitOverride({ content: text, mentions: [], attachments: [] })}>
            Send message
          </button>
        </div>
      );
    },
  };
});
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: state.push }),
}));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  useMergePullRequest: () => ({
    isLoading: false,
    isError: state.prError !== null,
    error: state.prError,
    data: state.prError ? undefined : state.pr,
    refetch: vi.fn(),
  }),
  useLinkMergePullRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnlinkMergePullRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldmerge-review-queries', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/queries/use-weldmerge-review-queries')>()),
  useMergePullRequestFiles: () => ({ isLoading: false, isError: false, data: state.files, refetch: vi.fn() }),
  useMergePullRequestThreads: () => ({ isLoading: false, isError: false, isSuccess: true, data: state.threads, refetch: vi.fn() }),
  useSubmitMergeReview: () => ({ mutateAsync: state.review, isPending: false }),
  useCreateMergePullRequestComment: () => ({ mutateAsync: state.comment, isPending: false }),
  useMergePullRequestOnProvider: () => ({ mutateAsync: state.merge, isPending: false }),
}));
vi.mock('../components/link-issue-popover', () => ({ LinkIssuePopover: () => null }));

const tm = en.weldmerge;
const tr = tm.reviewing;

function renderPanel(locale: 'en' | 'nl' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage={locale}>
        <PullRequestPanel id="mpr_1" isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

function openFiles() {
  openTab(tr.tabs.files);
}

/** Clicks the add-comment button of the n-th commentable line. */
function commentOnLine(index: number) {
  fireEvent.click(screen.getAllByRole('button', { name: tr.files.addComment })[index]);
}

describe('WeldMerge pull request panel', () => {
  beforeEach(() => {
    state.can = true;
    state.pr = { ...makePullRequest(), body: 'Body text', headSha: 'abc', syncedAt: '2026-11-05T11:00:00.000Z' };
    state.prError = null;
    state.files = [FILE];
    state.threads = [THREAD];
    state.review = vi.fn().mockResolvedValue({});
    state.comment = vi.fn().mockResolvedValue({});
    state.merge = vi.fn().mockResolvedValue({});
    state.push = vi.fn();
  });

  it('shows the pull request as a record: title, then state, author and branches as its details', () => {
    // No threads, so the author's login only shows in the Author row.
    state.threads = [];
    renderPanel();
    expect(screen.getByText('feat(weldflow): tab visibility per project')).toBeTruthy();
    expect(screen.getByText('#1466')).toBeTruthy();
    expect(screen.getByText(tm.pullRequests.state)).toBeTruthy();
    expect(screen.getByText(tm.prState.open)).toBeTruthy();
    expect(screen.getByText('GitHub · weldsuite/weldsuite')).toBeTruthy();
    expect(screen.getByText('sanne')).toBeTruthy();
    expect(screen.getByText('claude/weldflow-tab-visibility')).toBeTruthy();
    expect(screen.getByText('develop')).toBeTruthy();
    expect(screen.getByText(tm.pullRequests.synced)).toBeTruthy();
    // Description, issues and merging each have a tab of their own.
    expect(screen.queryByText('Body text')).toBeNull();
    expect(screen.queryByRole('button', { name: tr.merge.button })).toBeNull();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      en.sweep.entities.detailsTab,
      tr.tabs.description,
      tr.tabs.files,
      tr.tabs.issues,
      tr.tabs.merge,
    ]);
  });

  it('shows the description in its own tab, and says so when there is none', () => {
    const view = renderPanel();
    openTab(tr.tabs.description);
    expect(screen.getByText('Body text')).toBeTruthy();
    view.unmount();

    state.pr = { ...makePullRequest(), body: null, headSha: null, syncedAt: '2026-11-05T11:00:00.000Z' };
    renderPanel();
    openTab(tr.tabs.description);
    expect(screen.getByText(tm.pullRequests.noDescriptionTitle)).toBeTruthy();
  });

  it('lists the linked issues in their own tab and opens one', () => {
    renderPanel();
    openTab(tr.tabs.issues);
    expect(screen.getByText('PLAT-209')).toBeTruthy();
    expect(screen.getByText(tm.pullRequests.closesIssue)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'PLAT-209 Tab visibility' }));
    expect(state.push).toHaveBeenCalledWith('/weldmerge/issues/PLAT-209');
  });

  it('says so when the pull request is gone, without a retry', () => {
    state.prError = Object.assign(new Error('Not found'), { name: 'ApiError', status: 404, isApiError: true });
    renderPanel();
    expect(screen.getByText(tm.pullRequests.notFound)).toBeTruthy();
    expect(screen.queryByRole('button', { name: tm.retry })).toBeNull();
  });

  it('renders the files with counts, line numbers and the existing thread inline', () => {
    renderPanel();
    openFiles();
    expect(screen.getAllByText('tabs.ts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    expect(screen.getByText('const c = 4;')).toBeTruthy();
    expect(screen.getAllByText('Why three?').length).toBeGreaterThan(0);
    expect(screen.getByText(tr.files.viewed)).toBeTruthy();
  });

  it('folds a file away when it is marked viewed', () => {
    renderPanel();
    openFiles();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText('const c = 4;')).toBeNull();
  });

  it('sends pending line comments with the review', async () => {
    renderPanel();
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
    renderPanel();
    openFiles();
    commentOnLine(1);
    fireEvent.change(screen.getByPlaceholderText(tr.draft.placeholder), { target: { value: 'Why remove?' } });
    fireEvent.click(screen.getByRole('button', { name: tr.draft.commentNow }));
    await waitFor(() =>
      expect(state.comment).toHaveBeenCalledWith({ body: 'Why remove?', path: 'src/app/tabs.ts', line: 2, side: 'LEFT' }),
    );
  });

  it('posts a general comment from the chat composer under the details', async () => {
    renderPanel();
    // The provider's conversation sits under the Details rows, not in a sidebar or a tab of its own.
    expect(screen.getByRole('region', { name: tr.conversation.heading })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: tr.conversation.heading })).toBeNull();
    fireEvent.change(screen.getByLabelText(tr.conversation.newCommentPlaceholder), { target: { value: 'Looks good to me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(state.comment).toHaveBeenCalledWith({ body: 'Looks good to me' }));
  });

  it('shows comments as chat messages and replies to a thread through the composer', async () => {
    renderPanel();
    const row = screen.getAllByTestId('merge-conversation-comment')[0]!;
    expect(row.textContent).toContain('sanne');
    expect(row.textContent).toContain('Why three?');
    expect(row.textContent).toContain(fill(tr.conversation.onLine, { path: 'src/app/tabs.ts', line: 2 }));
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole('button', { name: tr.conversation.reply }));
    fireEvent.change(screen.getByLabelText(tr.conversation.newCommentPlaceholder), { target: { value: 'Because of the tabs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(state.comment).toHaveBeenCalledWith({ body: 'Because of the tabs', inReplyToId: 'thr_1' }));
  });

  it('shows the not-linked notice with a link to the accounts settings', async () => {
    state.review = vi.fn().mockRejectedValue(Object.assign(new Error('Link your account'), { body: { error: { code: 'account_not_linked' } } }));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tr.review.button) }));
    fireEvent.click(await screen.findByLabelText(new RegExp('^' + tr.review.approve)));
    fireEvent.click(screen.getByRole('button', { name: tr.review.submit }));
    const link = await screen.findByRole('link', { name: tr.errors.linkAccount });
    expect(link.getAttribute('href')).toBe('/weldmerge/settings?tab=accounts');
  });

  it('merges after a confirmation, and blocks a draft with a reason', async () => {
    const view = renderPanel();
    openTab(tr.tabs.merge);
    fireEvent.click(screen.getByRole('button', { name: tr.merge.button }));
    fireEvent.click(await screen.findByRole('button', { name: tr.merge.confirmLabel }));
    await waitFor(() => expect(state.merge).toHaveBeenCalledWith({ method: 'merge' }));
    view.unmount();

    state.pr = { ...makePullRequest({ draft: true }), body: null, headSha: null, syncedAt: '2026-11-05T11:00:00.000Z' };
    renderPanel();
    openTab(tr.tabs.merge);
    expect(screen.getByText(tr.merge.disabled.draft)).toBeTruthy();
    expect((screen.getByRole('button', { name: tr.merge.button }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the Merge tab out once the pull request is merged', () => {
    state.pr = { ...makePullRequest({ state: 'merged' }), body: null, headSha: null, syncedAt: '2026-11-05T11:00:00.000Z' };
    renderPanel();
    expect(screen.queryByRole('tab', { name: tr.tabs.merge })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(tr.review.button) })).toBeNull();
  });

  it('asks for a second confirmation wording when checks fail', async () => {
    state.pr = { ...makePullRequest({ checksStatus: 'failure' }), body: null, headSha: null, syncedAt: '2026-11-05T11:00:00.000Z' };
    renderPanel();
    openTab(tr.tabs.merge);
    fireEvent.click(screen.getByRole('button', { name: tr.merge.button }));
    expect(await screen.findByText(tr.merge.confirmFailingChecks)).toBeTruthy();
    expect(screen.getByRole('button', { name: tr.merge.confirmAnyway })).toBeTruthy();
  });

  it('hides review and merge without the permissions', () => {
    state.can = false;
    renderPanel();
    expect(screen.queryByRole('button', { name: new RegExp(tr.review.button) })).toBeNull();
    expect(screen.queryByRole('tab', { name: tr.tabs.merge })).toBeNull();
    expect(screen.getByText(tm.pullRequests.readOnlyNote)).toBeTruthy();
    expect(screen.getByText('Why three?')).toBeTruthy();
    expect(screen.queryByLabelText(tr.conversation.newCommentPlaceholder)).toBeNull();
  });

  it('says so under the details when nobody has commented, and keeps the composer', () => {
    state.threads = [];
    renderPanel();
    expect(screen.getByText(tr.conversation.empty)).toBeTruthy();
    expect(screen.getByLabelText(tr.conversation.newCommentPlaceholder)).toBeTruthy();
  });

  it('keeps resolved threads collapsed in the conversation and speaks Dutch', async () => {
    state.threads = [{ ...THREAD, resolved: true }];
    renderPanel('nl');
    // The Dutch bundle loads lazily; the first render is English.
    expect(await screen.findByRole('tab', { name: nl.weldmerge.reviewing.tabs.files })).toBeTruthy();
    expect(screen.getByText(nl.weldmerge.reviewing.conversation.heading)).toBeTruthy();
    expect(screen.getByText(nl.weldmerge.reviewing.conversation.showResolved)).toBeTruthy();
    expect(screen.queryByText(nl.weldmerge.reviewing.conversation.hideResolved)).toBeNull();
    fireEvent.click(screen.getByText(nl.weldmerge.reviewing.conversation.showResolved));
    expect(screen.getByText('Why three?')).toBeTruthy();
  });
});
