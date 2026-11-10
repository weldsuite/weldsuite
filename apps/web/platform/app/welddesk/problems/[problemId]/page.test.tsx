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
  useParams: () => ({ problemId: 'dprob_1' }),
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
vi.mock('../problem-incidents-card', () => ({ ProblemIncidentsCard: () => <div data-testid="incidents-card" /> }));
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
  state.perms = new Set(['problems:read', 'problems:update', 'problems:delete', 'articles:create']);
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
