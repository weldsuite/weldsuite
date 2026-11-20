/**
 * One problem: the texts saved with Save (only what changed), a status
 * change carrying the texts typed so far, the server's refusal shown, a
 * read-only view without problems:update, the article and deleting.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeskProblem, DeskProblemUpdate } from '@/hooks/queries/use-desk-problem-queries';

interface MutateOptions {
  onSuccess?: (res: { data: DeskProblem }) => void;
  onError?: (err: unknown) => void;
}

const state = vi.hoisted(() => ({
  problem: {} as unknown,
  problemId: 'dprob_1',
  perms: new Set<string>(),
  push: vi.fn<(href: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  update: vi.fn<(input: { id: string; patch: DeskProblemUpdate }, options: MutateOptions) => void>(),
  article: vi.fn<(id: string, options: MutateOptions) => void>(),
  remove: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('sonner', () => ({ toast: { error: (m: string) => state.toastError(m), success: (m: string) => state.toastSuccess(m), warning: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push: state.push }),
  useParams: () => ({ problemId: state.problemId }),
}));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }), useAppApi: () => ({}) }));
vi.mock('@/hooks/queries/use-desk-workspace-members', () => ({
  useDeskWorkspaceMembers: () => ({ data: [{ userId: 'user_ada', name: 'Ada Lovelace' }] }),
}));
vi.mock('@/hooks/queries/use-desk-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-desk-queries')>()),
  useDeskAttributeOptions: () => ({ data: { teams: [{ id: 'dept_pay', name: 'Payments' }] } }),
}));
vi.mock('@/hooks/queries/use-desk-link-queries', () => ({
  deskLinkErrorMessage: () => null,
  deskLinkRefusal: (err: { reason?: string }) => err.reason ?? null,
}));
vi.mock('@/hooks/queries/use-desk-problem-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-desk-problem-queries')>()),
  useDeskProblem: () => ({ data: state.problem, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateDeskProblem: () => ({ mutate: state.update, isPending: false }),
  useCreateDeskProblemArticle: () => ({ mutate: state.article, isPending: false }),
  useDeleteDeskProblem: () => ({ mutateAsync: state.remove, isPending: false }),
}));

// The cards below the form have their own tests and queries.
vi.mock('../problem-incidents-card', () => ({
  ProblemIncidentsCard: ({ canUpdate }: { canUpdate: boolean }) => <div data-testid="incidents-card" data-can-update={String(canUpdate)} />,
}));
vi.mock('../share-workaround-dialog', () => ({
  ShareWorkaroundDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="share-dialog" /> : null),
}));
// Native controls stand in for the Radix selects, which need a real layout.
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select aria-label="Status" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));
vi.mock('../../inbox/ticket-fields', () => ({
  PickOne: ({ testId, onChange }: { testId?: string; onChange: (value: string | null) => void }) => (
    <button type="button" data-testid={testId} onClick={() => onChange('picked')}>
      pick
    </button>
  ),
}));
vi.mock('@weldsuite/ui/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, onConfirm }: { open: boolean; title: string; onConfirm: () => void }) =>
    open ? (
      <div data-testid="confirm">
        <p>{title}</p>
        <button type="button" onClick={() => void onConfirm()}>
          Confirm delete
        </button>
      </div>
    ) : null,
}));

import DeskProblemPage from './page';

function problem(overrides: Partial<DeskProblem> = {}): DeskProblem {
  return {
    id: 'dprob_1',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-02T10:00:00.000Z',
    problemNumber: 7,
    title: 'Checkout fails',
    description: 'The pay button does nothing',
    status: 'investigating',
    priority: 'high',
    rootCause: null,
    workaround: null,
    resolution: null,
    assigneeId: 'user_ada',
    departmentId: 'dept_pay',
    articleId: null,
    knownErrorAt: null,
    resolvedAt: null,
    closedAt: null,
    createdById: null,
    incidentCount: 2,
    openIncidentCount: 2,
    ...overrides,
  };
}

const field = (name: string) => screen.getByTestId(`desk-problem-${name}`) as HTMLTextAreaElement;

beforeEach(() => {
  state.problem = problem();
  state.problemId = 'dprob_1';
  state.perms = new Set(['problems:read', 'problems:update', 'problems:delete', 'articles:create', 'conversations:update']);
  for (const mock of [state.push, state.toastError, state.toastSuccess, state.update, state.article, state.remove]) mock.mockReset();
  state.remove.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('DeskProblemPage', () => {
  it('shows the problem with its number, status and texts', () => {
    render(<DeskProblemPage />);
    expect(screen.getByText('Problem #7')).toBeTruthy();
    expect(screen.getByTestId('desk-problem-status').textContent).toBe('Investigating');
    expect(field('description').value).toBe('The pay button does nothing');
    expect(screen.getByTestId('incidents-card')).toBeTruthy();
  });

  it('saves only the texts that changed, and clears the unsaved note afterwards', () => {
    render(<DeskProblemPage />);
    const save = screen.getByTestId('desk-problem-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(field('workaround'), { target: { value: 'Use PayPal' } });
    expect(save.disabled).toBe(false);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(save);

    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update.mock.calls[0]![0]).toEqual({ id: 'dprob_1', patch: { workaround: 'Use PayPal' } });
    // The query cache holds the saved problem by the time the callback runs.
    state.problem = problem({ workaround: 'Use PayPal' });
    act(() => state.update.mock.calls[0]![1].onSuccess?.({ data: problem({ workaround: 'Use PayPal' }) }));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(state.toastSuccess).toHaveBeenCalledWith('Saved');
  });

  it('clears a text that was emptied, and will not save an empty title', () => {
    state.problem = problem({ rootCause: 'Gateway timeout' });
    render(<DeskProblemPage />);
    fireEvent.change(field('rootCause'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('desk-problem-save'));
    expect(state.update.mock.calls[0]![0].patch).toEqual({ rootCause: null });

    fireEvent.change(screen.getByDisplayValue('Checkout fails'), { target: { value: '  ' } });
    expect((screen.getByTestId('desk-problem-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a status change together with the texts typed so far', () => {
    render(<DeskProblemPage />);
    fireEvent.change(field('workaround'), { target: { value: 'Use PayPal' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'known_error' } });
    expect(state.update.mock.calls[0]![0]).toEqual({ id: 'dprob_1', patch: { workaround: 'Use PayPal', status: 'known_error' } });
  });

  it("shows the server's reason when a known error has no workaround", () => {
    render(<DeskProblemPage />);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'known_error' } });
    state.update.mock.calls[0]![1].onError?.({ reason: 'workaround_required' });
    expect(state.toastError).toHaveBeenCalledWith('A known error needs a workaround or a root cause.');
  });

  it('changes priority, owner and team straight away', () => {
    render(<DeskProblemPage />);
    fireEvent.click(screen.getByTestId('desk-problem-priority'));
    fireEvent.click(screen.getByTestId('desk-problem-owner'));
    fireEvent.click(screen.getByTestId('desk-problem-team'));
    expect(state.update.mock.calls.map((call) => call[0].patch)).toEqual([
      { priority: 'picked' },
      { assigneeId: 'picked' },
      { departmentId: 'picked' },
    ]);
  });

  it('is read-only without problems:update', () => {
    state.perms = new Set(['problems:read']);
    render(<DeskProblemPage />);
    expect(field('workaround').disabled).toBe(true);
    expect(screen.queryByTestId('desk-problem-save-bar')).toBeNull();
    expect(screen.queryByTestId('desk-problem-share-open')).toBeNull();
    expect(screen.queryByTestId('desk-problem-delete')).toBeNull();
    expect(screen.queryByTestId('desk-problem-create-article')).toBeNull();
  });

  it('opens the share dialog', () => {
    render(<DeskProblemPage />);
    expect(screen.queryByTestId('share-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('desk-problem-share-open'));
    expect(screen.getByTestId('share-dialog')).toBeTruthy();
  });

  it('creates the article and opens it, or opens the one that exists', () => {
    const { unmount } = render(<DeskProblemPage />);
    fireEvent.click(screen.getByTestId('desk-problem-create-article'));
    expect(state.article.mock.calls[0]![0]).toBe('dprob_1');
    state.article.mock.calls[0]![1].onSuccess?.({ data: problem({ articleId: 'art_9' }) });
    expect(state.push).toHaveBeenCalledWith('/welddesk/help-center/articles/art_9/edit');
    unmount();

    state.problem = problem({ articleId: 'art_9' });
    render(<DeskProblemPage />);
    expect(screen.queryByTestId('desk-problem-create-article')).toBeNull();
    expect(screen.getByRole('link', { name: /Open article/ }).getAttribute('href')).toBe('/welddesk/help-center/articles/art_9/edit');
  });

  it('deletes only after the confirmation, then goes back to the list', async () => {
    render(<DeskProblemPage />);
    fireEvent.click(screen.getByTestId('desk-problem-delete'));
    expect(state.remove).not.toHaveBeenCalled();
    expect(screen.getByText('Delete problem #7?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await vi.waitFor(() => expect(state.push).toHaveBeenCalledWith('/welddesk/problems'));
    expect(state.remove).toHaveBeenCalledWith('dprob_1');
  });
});

describe('permissions on what writes to tickets', () => {
  const card = () => screen.getByTestId('incidents-card').getAttribute('data-can-update');

  it('links and unlinks tickets only with problems:update and conversations:update', () => {
    const { unmount } = render(<DeskProblemPage />);
    expect(card()).toBe('true');
    unmount();

    state.perms = new Set(['problems:read', 'problems:update']);
    const second = render(<DeskProblemPage />);
    expect(card()).toBe('false');
    second.unmount();

    state.perms = new Set(['problems:read', 'conversations:update']);
    render(<DeskProblemPage />);
    expect(card()).toBe('false');
  });

  it('offers sharing the workaround only with both permissions', () => {
    state.perms = new Set(['problems:read', 'problems:update']);
    const { unmount } = render(<DeskProblemPage />);
    expect(screen.queryByTestId('desk-problem-share-open')).toBeNull();
    unmount();

    state.perms = new Set(['problems:read', 'conversations:update']);
    const second = render(<DeskProblemPage />);
    expect(screen.queryByTestId('desk-problem-share-open')).toBeNull();
    second.unmount();

    state.perms = new Set(['problems:read', 'problems:update', 'conversations:update']);
    render(<DeskProblemPage />);
    expect(screen.getByTestId('desk-problem-share-open')).toBeTruthy();
  });
});

describe('the draft', () => {
  it('starts afresh when the route moves to another problem', () => {
    const { rerender } = render(<DeskProblemPage />);
    fireEvent.change(field('workaround'), { target: { value: 'Use PayPal' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    state.problemId = 'dprob_2';
    state.problem = problem({ id: 'dprob_2', problemNumber: 8, title: 'Search is slow', description: 'Takes ten seconds', workaround: null });
    rerender(<DeskProblemPage />);

    expect(screen.getByText('Problem #8')).toBeTruthy();
    expect(field('workaround').value).toBe('');
    expect(field('description').value).toBe('Takes ten seconds');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect((screen.getByTestId('desk-problem-save') as HTMLButtonElement).disabled).toBe(true);
    // Saving there sends nothing of the first problem's draft.
    fireEvent.change(field('rootCause'), { target: { value: 'Missing index' } });
    fireEvent.click(screen.getByTestId('desk-problem-save'));
    expect(state.update.mock.calls[0]![0]).toEqual({ id: 'dprob_2', patch: { rootCause: 'Missing index' } });
  });

  it('follows the server in the texts that were not touched, and keeps what is being typed', () => {
    const { rerender } = render(<DeskProblemPage />);
    fireEvent.change(field('workaround'), { target: { value: 'Use PayPal' } });

    state.problem = problem({ description: 'Changed by a colleague', workaround: 'Their workaround' });
    rerender(<DeskProblemPage />);

    expect(field('description').value).toBe('Changed by a colleague');
    expect(field('workaround').value).toBe('Use PayPal');
    fireEvent.click(screen.getByTestId('desk-problem-save'));
    // Only the text the agent edited is sent, not the colleague's change.
    expect(state.update.mock.calls[0]![0].patch).toEqual({ workaround: 'Use PayPal' });
  });

  it('is clean again once it matches what the server holds', () => {
    const { rerender } = render(<DeskProblemPage />);
    fireEvent.change(field('workaround'), { target: { value: 'Use PayPal' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    state.problem = problem({ workaround: 'Use PayPal' });
    rerender(<DeskProblemPage />);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('is reset to the saved problem after a save, and discarding goes back to the server value', () => {
    render(<DeskProblemPage />);
    fireEvent.change(field('description'), { target: { value: 'Typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(field('description').value).toBe('The pay button does nothing');
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    fireEvent.change(field('description'), { target: { value: 'Typed again' } });
    fireEvent.click(screen.getByTestId('desk-problem-save'));
    act(() => state.update.mock.calls[0]![1].onSuccess?.({ data: problem({ description: 'Typed again' }) }));
    // The query has not refetched yet: the draft is the saved problem, not a leftover.
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(field('description').value).toBe('Typed again');
  });
});
