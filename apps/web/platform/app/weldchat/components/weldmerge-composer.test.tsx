import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MergeAlsoPostToggle, MergeSharePicker, useWeldMergeComposer } from './weldmerge-composer';

const state = vi.hoisted(() => ({
  can: {} as Record<string, boolean>,
  installed: true,
  teams: [{ id: 'mtm_1', key: 'PLAT', name: 'Platform' }, { id: 'mtm_2', key: 'WEB', name: 'Web' }],
  createIssue: vi.fn(),
  comment: vi.fn(),
  get: vi.fn(),
  search: { isFetching: false, isError: false, data: undefined as unknown },
  searchedFor: [] as string[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.can[key] === true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: state.installed, isLoading: false }) }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/lib/workspace-url-rewrite', () => ({ toPublicPath: (path: string) => path }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ weldmerge: { teams: { list: async () => ({ data: state.teams }) } } }),
  useAppApiClient: () => ({ getClient: async () => ({ get: state.get }) }),
}));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  weldmergeKeys: { all: ['weldmerge'], teams: () => ['weldmerge', 'teams'] },
  useCreateMergeIssue: () => ({ mutateAsync: state.createIssue, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useCommentOnMergePullRequest: () => ({ mutate: state.comment, isPending: false }),
  useMergeShareSearch: (query: string) => {
    state.searchedFor.push(query);
    return state.search;
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  state.can = { 'merge_issues:read': true, 'merge_issues:create': true, 'merge_pull_requests:review': true };
  state.installed = true;
  state.createIssue = vi.fn().mockResolvedValue({ key: 'PLAT-300', title: 'Fix login' });
  state.comment = vi.fn();
  state.get = vi.fn().mockResolvedValue({ data: { metadata: { weldmerge: { kind: 'review_requested', pullRequestId: 'mpr_1' } } } });
  state.search = { isFetching: false, isError: false, data: [] };
  state.searchedFor = [];
});

describe('useWeldMergeComposer', () => {
  it('is on when the app is installed and the member may read issues', () => {
    expect(renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper }).result.current.enabled).toBe(true);
    state.installed = false;
    expect(renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper }).result.current.enabled).toBe(false);
    state.installed = true;
    state.can['merge_issues:read'] = false;
    expect(renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper }).result.current.enabled).toBe(false);
  });

  it('creates an issue in the first team from /issue <title>', async () => {
    const { result } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper });
    let done = false;
    await act(async () => {
      done = await result.current.runIssueCommand('/issue Fix login');
    });
    expect(done).toBe(true);
    expect(state.createIssue).toHaveBeenCalledWith({ teamId: 'mtm_1', title: 'Fix login' });
  });

  it('takes a leading team key', async () => {
    const { result } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper });
    await act(async () => {
      await result.current.runIssueCommand('/issue web Fix login');
    });
    expect(state.createIssue).toHaveBeenCalledWith({ teamId: 'mtm_2', title: 'Fix login' });
  });

  it('keeps the text when there is no title or the create fails', async () => {
    const { result, rerender } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper });
    let done = true;
    await act(async () => {
      done = await result.current.runIssueCommand('/issue');
    });
    expect(done).toBe(false);
    expect(state.createIssue).not.toHaveBeenCalled();

    state.createIssue = vi.fn().mockRejectedValue(new Error('boom'));
    rerender();
    await act(async () => {
      done = await result.current.runIssueCommand('/issue Fix');
    });
    expect(done).toBe(false);
  });

  it('does not create without merge_issues:create', async () => {
    state.can['merge_issues:create'] = false;
    const { result } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper });
    let done = true;
    await act(async () => {
      done = await result.current.runIssueCommand('/issue Fix login');
    });
    expect(done).toBe(false);
    expect(state.createIssue).not.toHaveBeenCalled();
  });

  it('takes /issue and /merge off the composer and leaves other text alone', async () => {
    const { result } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper });
    const handled = vi.fn();
    expect(result.current.runSlashCommand('hello there', handled)).toBe(false);
    expect(result.current.runSlashCommand('/issues are fun', handled)).toBe(false);
    // A typed /merge found nothing to share: swallowed, and the text stays.
    expect(result.current.runSlashCommand('/merge login', handled)).toBe(true);
    expect(result.current.runSlashCommand('/merge', handled)).toBe(true);
    expect(handled).not.toHaveBeenCalled();
    expect(result.current.runSlashCommand('/issue Fix login', handled)).toBe(true);
    await waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    expect(state.createIssue).toHaveBeenCalledWith({ teamId: 'mtm_1', title: 'Fix login' });
  });

  it('leaves every slash command alone when WeldMerge is off', () => {
    state.installed = false;
    const { result } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1' }), { wrapper });
    expect(result.current.runSlashCommand('/issue Fix login', vi.fn())).toBe(false);
    expect(result.current.runSlashCommand('/merge login', vi.fn())).toBe(false);
  });

  it('finds the pull request behind a card thread and posts the reply there when asked', async () => {
    const { result } = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1', parentId: 'msg_1' }), { wrapper });
    await waitFor(() => expect(result.current.threadPullRequestId).toBe('mpr_1'));
    expect(state.get).toHaveBeenCalledWith('/chat-messages/msg_1');

    act(() => result.current.commentOnPullRequest('first'));
    expect(state.comment).not.toHaveBeenCalled();

    act(() => result.current.setAlsoPost(true));
    act(() => result.current.commentOnPullRequest('LGTM'));
    expect(state.comment).toHaveBeenCalledWith({ id: 'mpr_1', body: 'LGTM' }, expect.any(Object));

    // An attachment-only reply has no text: nothing is posted to the provider.
    state.comment.mockClear();
    act(() => result.current.commentOnPullRequest('  '));
    expect(state.comment).not.toHaveBeenCalled();
  });

  it('has no pull request for a thread under an ordinary message or without review permission', async () => {
    state.get = vi.fn().mockResolvedValue({ data: { metadata: null } });
    const plain = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1', parentId: 'msg_2' }), { wrapper });
    await waitFor(() => expect(state.get).toHaveBeenCalled());
    expect(plain.result.current.threadPullRequestId).toBeNull();

    state.get = vi.fn();
    state.can['merge_pull_requests:review'] = false;
    const noReview = renderHook(() => useWeldMergeComposer({ channelId: 'ch_1', parentId: 'msg_3' }), { wrapper });
    expect(noReview.result.current.threadPullRequestId).toBeNull();
    expect(state.get).not.toHaveBeenCalled();
  });
});

describe('MergeAlsoPostToggle', () => {
  it('reports the choice', () => {
    const onChange = vi.fn();
    render(<MergeAlsoPostToggle checked={false} onCheckedChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also post on the pull request' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('MergeSharePicker', () => {
  const results = [
    { type: 'issue' as const, id: 'mis_1', key: 'PLAT-209', title: 'Login slow' },
    { type: 'pull_request' as const, id: 'mpr_1', key: 'acme/api #12', title: 'Fix login' },
  ];

  it('lists the results and shares the clicked one', () => {
    state.search = { isFetching: false, isError: false, data: results };
    const onPick = vi.fn();
    render(
      <div data-chat-composer-root="">
        <MergeSharePicker query="login" onPick={onPick} onDismiss={vi.fn()} />
      </div>,
    );
    expect(state.searchedFor).toContain('login');
    fireEvent.mouseDown(screen.getByText('Fix login'));
    expect(onPick).toHaveBeenCalledWith(results[1]);
  });

  it('moves with the arrow keys and shares on Enter without letting it reach the composer', () => {
    state.search = { isFetching: false, isError: false, data: results };
    const onPick = vi.fn();
    const editorKeyDown = vi.fn();
    render(
      <div data-chat-composer-root="">
        <MergeSharePicker query="login" onPick={onPick} onDismiss={vi.fn()} />
        <div data-testid="editor" role="textbox" tabIndex={0} aria-label="editor" contentEditable suppressContentEditableWarning onKeyDown={(e) => editorKeyDown(e.key)} />
      </div>,
    );
    const editor = screen.getByTestId('editor');
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(results[1]);
    expect(editorKeyDown).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onDismiss = vi.fn();
    render(
      <div data-chat-composer-root="">
        <MergeSharePicker query="login" onPick={vi.fn()} onDismiss={onDismiss} />
        <div data-testid="editor" contentEditable suppressContentEditableWarning />
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('lets Enter through when nothing matched', () => {
    const editorKeyDown = vi.fn();
    render(
      <div data-chat-composer-root="">
        <MergeSharePicker query="zzz" onPick={vi.fn()} onDismiss={vi.fn()} />
        <div data-testid="editor" role="textbox" tabIndex={0} aria-label="editor" contentEditable suppressContentEditableWarning onKeyDown={(e) => editorKeyDown(e.key)} />
      </div>,
    );
    expect(screen.getByText('Nothing found for zzz.')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 'Enter' });
    expect(editorKeyDown).toHaveBeenCalledWith('Enter');
  });

  it('shows a failure', () => {
    state.search = { isFetching: false, isError: true, data: undefined };
    render(<MergeSharePicker query="x" onPick={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('Could not search WeldMerge.')).toBeTruthy();
  });
});
