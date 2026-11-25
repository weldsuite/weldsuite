import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { RetroCard, Sprint, SprintReport } from '@weldsuite/app-api-client/schemas/flow-agile';

type Query<T> = { isLoading: boolean; isError: boolean; data: T | undefined; error?: unknown; refetch: () => void };

const state = vi.hoisted(() => ({
  delivery: { available: true, isLoading: false },
  sprint: { isLoading: false, isError: false, data: undefined, error: undefined, refetch: vi.fn() } as Query<unknown>,
  report: { isLoading: false, isError: false, data: undefined, refetch: vi.fn() } as Query<unknown>,
  items: { isLoading: false, isError: false, data: undefined, refetch: vi.fn() } as Query<unknown>,
  retro: { isLoading: false, isError: false, data: undefined, refetch: vi.fn() } as Query<unknown>,
  itemsArgs: vi.fn(),
  openPanel: vi.fn(),
  userId: 'u1' as string | null,
  canWrite: true,
  isAdmin: false,
  allowed: new Set<string>(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
  voteCard: vi.fn(),
  makeTask: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ projectId: 'p1', sprintId: 's1' }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: state.userId }) }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (key: string) => state.allowed.has(key) }) }));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: state.openPanel }) }));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  useProjectPermissions: () => ({ canWrite: state.canWrite, isAdmin: state.isAdmin }),
}));
vi.mock('@/app/weldflow/project/[projectId]/close/_lib/members', () => ({
  useMemberDirectory: () => ({
    memberOf: (id: string) => (id === 'u1' ? { name: 'Ada Lovelace', avatar: null } : undefined),
  }),
}));
vi.mock('@/app/weldflow/components/sub-nav', () => ({
  ProjectSubNavLayout: ({ items, children }: { items: { id: string; label: string }[]; children: ReactNode }) => (
    <div>
      <nav>
        {items.map((item) => (
          <span key={item.id}>{item.label}</span>
        ))}
      </nav>
      {children}
    </div>
  ),
}));
vi.mock('@/app/weldflow/project/[projectId]/pipeline/_components/sprint-actions', () => ({
  SprintActions: ({ sprint }: { sprint: { id: string } }) => <span data-testid="sprint-actions">{sprint.id}</span>,
}));
vi.mock('@/app/weldflow/project/[projectId]/pipeline/page', () => ({
  PipelineView: (props: Record<string, unknown>) => <div data-testid="pipeline" data-props={JSON.stringify(props)} />,
}));
vi.mock('@/components/weldflow/agile/burndown-chart', () => ({
  BurndownChart: ({ points }: { points: unknown[] }) => <div data-testid="burndown">{points.length} points</div>,
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => state.delivery,
  useSprint: () => state.sprint,
  useSprintReport: () => state.report,
  useRetroCards: () => state.retro,
  useCreateRetroCard: () => ({ mutate: state.createCard, isPending: false }),
  useUpdateRetroCard: () => ({ mutate: state.updateCard, isPending: false }),
  useDeleteRetroCard: () => ({ mutateAsync: state.deleteCard, isPending: false }),
  useVoteRetroCard: () => ({ mutate: state.voteCard, isPending: false }),
}));
vi.mock('@/hooks/queries/use-flow-agile-sprint-queries', () => ({
  useProjectItems: (...args: unknown[]) => {
    state.itemsArgs(...args);
    return state.items;
  },
  useMakeRetroActionTask: () => ({ mutate: state.makeTask, isPending: false }),
  isClosedStatus: (status: string | null | undefined) => ['done', 'completed', 'cancelled'].includes((status ?? '').toLowerCase()),
}));

import SprintLayout from './layout';
import SprintBoardPage from './page';
import SprintReportPage from './report/page';
import SprintRetroPage from './retro/page';

const wrap = (node: ReactNode) => <I18nProvider initialLanguage="en">{node}</I18nProvider>;

function sprint(extra: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    projectId: 'p1',
    name: 'Sprint 1',
    goal: null,
    status: 'active',
    startDate: '2026-11-01',
    endDate: '2026-11-14',
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

function report(extra: Partial<SprintReport> = {}): SprintReport {
  return {
    committed: { points: 10, count: 4, taskIds: [] },
    completed: { points: 5, count: 2 },
    added: { points: 3, count: 1 },
    removed: { points: 1, count: 1 },
    carriedOver: { points: 8, count: 2, taskIds: ['t3'], toSprintId: 's2', toBacklog: 1 },
    goalMet: null,
    burndown: [{ date: '2026-11-02', remaining: 10, ideal: 10 }],
    ...extra,
  };
}

function card(id: string, category: RetroCard['category'], extra: Partial<RetroCard> = {}): RetroCard {
  return {
    id,
    projectId: 'p1',
    sprintId: 's1',
    category,
    text: `Card ${id}`,
    authorId: 'u1',
    voteCount: 0,
    votedByMe: false,
    createdBy: 'u1',
    createdAt: '2026-11-03T10:00:00Z',
    updatedAt: '2026-11-03T10:00:00Z',
    ...extra,
  };
}

const query = <T,>(data: T | undefined, extra: Partial<Query<T>> = {}): Query<T> => ({
  isLoading: false,
  isError: false,
  data,
  refetch: vi.fn(),
  ...extra,
});

beforeEach(() => {
  state.delivery = { available: true, isLoading: false };
  state.sprint = query(sprint());
  state.report = query(report());
  state.items = query([]);
  state.retro = query([]);
  state.itemsArgs.mockReset();
  state.openPanel.mockReset();
  state.userId = 'u1';
  state.canWrite = true;
  state.isAdmin = false;
  state.allowed = new Set(['projects:update', 'projects:delete', 'projects:create', 'tasks:create']);
  for (const fn of [state.createCard, state.updateCard, state.deleteCard, state.voteCard, state.makeTask, state.toastSuccess, state.toastError]) fn.mockReset();
  state.deleteCard.mockResolvedValue(undefined);
});

describe('SprintLayout', () => {
  const renderLayout = () =>
    render(
      wrap(
        <SprintLayout>
          <p>page body</p>
        </SprintLayout>,
      ),
    );

  it('says sprints are not available on an edition without them', () => {
    state.delivery = { available: false, isLoading: false };
    renderLayout();
    expect(screen.getByText('Sprints aren’t available on this edition.')).toBeInTheDocument();
  });

  it('shows a loader while the sprint loads', () => {
    state.sprint = query(undefined, { isLoading: true });
    renderLayout();
    expect(screen.queryByText('page body')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('says the sprint was not found for a 404, with a way back', () => {
    state.sprint = query(undefined, { isError: true, error: new ApiError('nope', 404) });
    renderLayout();
    expect(screen.getByText('Sprint not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Pipeline' })).toHaveAttribute('href', '/weldflow/project/p1/pipeline');
  });

  it('offers a retry for any other failure', async () => {
    const user = userEvent.setup();
    const failed = query(undefined, { isError: true, error: new ApiError('boom', 500) });
    state.sprint = failed;
    renderLayout();
    expect(screen.getByRole('alert')).toHaveTextContent('This sprint couldn’t be loaded.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(failed.refetch).toHaveBeenCalled();
  });

  it('shows the running sprint with its goal, actions, tabs and page', () => {
    state.sprint = query(sprint({ goal: 'Ship the board' }));
    renderLayout();
    expect(screen.getByRole('heading', { name: 'Sprint 1' })).toBeInTheDocument();
    expect(screen.getByText('Goal: Ship the board')).toBeInTheDocument();
    expect(screen.getByTestId('sprint-actions')).toHaveTextContent('s1');
    expect(screen.getByText('page body')).toBeInTheDocument();
    for (const label of ['Board', 'Report', 'Retro']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Pipeline' })).toHaveAttribute('href', '/weldflow/project/p1/pipeline?sprint=s1');
    // Not over yet: no result in the header.
    expect(screen.queryByText(/goal met/)).not.toBeInTheDocument();
  });

  it('shows the result of a completed sprint from its frozen report', () => {
    state.sprint = query(sprint({ status: 'completed', report: { completed: { points: 8, count: 3 }, committed: { points: 10, count: 4, taskIds: [] }, goalMet: true } }));
    renderLayout();
    expect(screen.getByText(/8 of 10 pts · goal met/)).toBeInTheDocument();
  });

  it('falls back to the sprint columns, and says when the goal was missed', () => {
    state.sprint = query(sprint({ status: 'completed', storyPointsCompleted: 4, storyPointsCommitted: 9, report: { goalMet: false } }));
    renderLayout();
    expect(screen.getByText(/4 of 9 pts · goal not met/)).toBeInTheDocument();
  });

  it('leaves the result out of a completed sprint without numbers', () => {
    state.sprint = query(sprint({ status: 'completed' }));
    renderLayout();
    expect(screen.queryByText(/ pts/)).not.toBeInTheDocument();
  });
});

describe('SprintBoardPage', () => {
  it('shows the Pipeline of the sprint inside the page', () => {
    render(wrap(<SprintBoardPage />));
    const props = JSON.parse(screen.getByTestId('pipeline').dataset.props!);
    expect(props).toEqual({ projectId: 'p1', sprintId: 's1', embedded: true });
  });
});

describe('SprintReportPage', () => {
  it('shows nothing where sprints are not available', () => {
    state.delivery = { available: false, isLoading: false };
    const { container } = render(wrap(<SprintReportPage />));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loader while the report loads', () => {
    state.report = query(undefined, { isLoading: true });
    render(wrap(<SprintReportPage />));
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('explains that a planned sprint has no burndown yet', () => {
    state.sprint = query(sprint({ status: 'planned' }));
    state.report = query(undefined, { isError: true });
    render(wrap(<SprintReportPage />));
    expect(screen.getByText('A sprint gets its burndown once it has started.')).toBeInTheDocument();
    // A planned sprint has no items to list: the query is off.
    expect(state.itemsArgs).toHaveBeenCalledWith('p1', false);
  });

  it('offers a retry when the report fails for a started sprint', async () => {
    const user = userEvent.setup();
    const failed = query(undefined, { isError: true });
    state.report = failed;
    render(wrap(<SprintReportPage />));
    expect(screen.getByRole('alert')).toHaveTextContent('The report couldn’t be loaded.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(failed.refetch).toHaveBeenCalled();
  });

  it('shows the live numbers and the done and not done lists of a running sprint', async () => {
    const user = userEvent.setup();
    state.items = query([
      { id: 't1', number: 1, title: 'Finished one', status: 'done', sprintId: 's1', storyPoints: 5 },
      { id: 't2', number: null, title: 'Still open', status: 'in_progress', sprintId: 's1', storyPoints: null },
      { id: 't9', number: 9, title: 'Other sprint', status: 'todo', sprintId: 's2', storyPoints: 1 },
    ]);
    render(wrap(<SprintReportPage />));
    expect(screen.getByText('Live numbers. They freeze when the sprint is completed.')).toBeInTheDocument();
    expect(screen.getByTestId('burndown')).toHaveTextContent('1 points');
    const numbers = screen.getByRole('region', { name: 'Numbers' });
    expect(within(numbers).getByText('Not decided yet')).toBeInTheDocument();
    expect(within(numbers).getByText('10 points')).toBeInTheDocument();
    expect(screen.getByText('Done · 1')).toBeInTheDocument();
    expect(screen.getByText('Not done · 1')).toBeInTheDocument();
    expect(screen.queryByText('Other sprint')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Finished one/ }));
    expect(state.openPanel).toHaveBeenCalledWith({ type: 'task', id: 't1' });
  });

  it('shows the frozen report of a completed sprint with what carried over', () => {
    state.sprint = query(sprint({ status: 'completed', completedAt: '2026-11-14T10:00:00Z' }));
    state.report = query(report({ goalMet: true, completedAt: '2026-11-14T10:00:00Z' }));
    state.items = query([
      { id: 't1', number: 1, title: 'Finished one', status: 'done', sprintId: 's1', storyPoints: 5 },
      { id: 't3', number: 3, title: 'Moved on', status: 'todo', sprintId: 's2', storyPoints: 2 },
    ]);
    render(wrap(<SprintReportPage />));
    expect(screen.getByText(/Frozen when the sprint was completed on/)).toBeInTheDocument();
    expect(screen.getByText('To the next sprint: 1 item · to the backlog: 1 item')).toBeInTheDocument();
    expect(screen.getByText('Carried over · 1')).toBeInTheDocument();
    expect(screen.getByText('Moved on')).toBeInTheDocument();
    expect(screen.getAllByText('Yes').length).toBeGreaterThan(0);
  });

  it('shows a missed goal, no burndown and empty lists', () => {
    state.report = query(report({ goalMet: false, burndown: [], carriedOver: { points: 0, count: 0, taskIds: [], toSprintId: null, toBacklog: 0 }, added: { points: 0, count: 0 } }));
    render(wrap(<SprintReportPage />));
    expect(screen.getByText('A sprint gets its burndown once it has started.')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('Nothing is done yet.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is left over.')).toBeInTheDocument();
  });

  it('shows placeholders while the items load and an error when they fail', () => {
    state.items = query(undefined, { isLoading: true });
    const { unmount } = render(wrap(<SprintReportPage />));
    expect(screen.getByText('Done · 0')).toBeInTheDocument();
    unmount();

    const failed = query(undefined, { isError: true });
    state.items = failed;
    render(wrap(<SprintReportPage />));
    expect(screen.getByText('The sprint’s items couldn’t be loaded.')).toBeInTheDocument();
  });
});

describe('SprintRetroPage', () => {
  it('shows a loader, and an error with a retry', async () => {
    state.retro = query(undefined, { isLoading: true });
    const { unmount } = render(wrap(<SprintRetroPage />));
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    unmount();

    const user = userEvent.setup();
    const failed = query(undefined, { isError: true });
    state.retro = failed;
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(failed.refetch).toHaveBeenCalled();
  });

  it('lays the cards out in four columns, most votes first, with the author', () => {
    state.retro = query([
      card('a', 'went_well', { voteCount: 1 }),
      card('b', 'went_well', { voteCount: 3, authorId: 'someone-else' }),
      card('c', 'went_well', { voteCount: 1, createdAt: '2026-11-02T10:00:00Z' }),
      card('d', 'action'),
    ]);
    render(wrap(<SprintRetroPage />));
    expect(screen.getByText('4 cards')).toBeInTheDocument();
    const wentWell = screen.getByRole('group', { name: 'Went well' });
    const texts = within(wentWell).getAllByRole('article').map((article) => article.querySelector('p')?.textContent);
    expect(texts).toEqual(['Card b', 'Card c', 'Card a']);
    expect(within(wentWell).getAllByText('Ada Lovelace')).toHaveLength(2);
    expect(within(wentWell).getByText('Unknown member')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Didn’t go well' })).getByText(/Nothing yet. What got in the way/)).toBeInTheDocument();
  });

  it('adds a card with Enter and shows a failure as a toast', async () => {
    const user = userEvent.setup();
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: 'Add to Went well' }));
    await user.type(screen.getByRole('textbox', { name: 'Card text' }), 'We shipped');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(state.createCard).toHaveBeenCalled());
    const [input, handlers] = state.createCard.mock.calls[0]!;
    expect(input).toEqual({ category: 'went_well', text: 'We shipped' });
    handlers.onSuccess();
    handlers.onError(new ApiError('Too long', 400));
    expect(state.toastError).toHaveBeenCalledWith('Too long');
    handlers.onError(new Error('x'));
    expect(state.toastError).toHaveBeenLastCalledWith('The card couldn’t be saved.');
  });

  it('cancels a new card with Escape or the button', async () => {
    const user = userEvent.setup();
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: 'Add to Try next' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add to Try next' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(state.createCard).not.toHaveBeenCalled();
  });

  it('edits the text of a card', async () => {
    const user = userEvent.setup();
    state.retro = query([card('a', 'went_well')]);
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: 'Edit card' }));
    const box = screen.getByRole('textbox', { name: 'Card text' });
    expect(box).toHaveValue('Card a');
    await user.clear(box);
    await user.type(box, 'Better text');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.updateCard).toHaveBeenCalled());
    const [input, handlers] = state.updateCard.mock.calls[0]!;
    expect(input).toEqual({ id: 'a', input: { text: 'Better text' } });
    handlers.onError(new Error('x'));
    expect(state.toastError).toHaveBeenCalledWith('The card couldn’t be saved.');
    handlers.onSuccess();
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });

  it('cancels an edit', async () => {
    const user = userEvent.setup();
    state.retro = query([card('a', 'went_well')]);
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: 'Edit card' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Card a')).toBeInTheDocument();
    expect(state.updateCard).not.toHaveBeenCalled();
  });

  it('votes and takes a vote back', async () => {
    const user = userEvent.setup();
    state.retro = query([card('a', 'went_well', { voteCount: 2, votedByMe: true })]);
    render(wrap(<SprintRetroPage />));
    const vote = screen.getByRole('button', { name: '2 votes' });
    expect(vote).toHaveAttribute('aria-pressed', 'true');
    await user.click(vote);
    const [input, handlers] = state.voteCard.mock.calls[0]!;
    expect(input).toEqual({ id: 'a', voted: true });
    handlers.onError(new Error('x'));
    expect(state.toastError).toHaveBeenCalledWith('Your vote couldn’t be saved.');
  });

  it('deletes a card after a confirmation, and reports a failure', async () => {
    const user = userEvent.setup();
    state.retro = query([card('a', 'went_well')]);
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: 'Delete card' }));
    expect(await screen.findByText('Delete this card?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.deleteCard).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.queryByText('Delete this card?')).not.toBeInTheDocument());

    state.deleteCard.mockRejectedValueOnce(new Error('x'));
    await user.click(screen.getByRole('button', { name: 'Delete card' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('The card couldn’t be deleted.'));
  });

  it('keeps a delete when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    state.retro = query([card('a', 'went_well')]);
    render(wrap(<SprintRetroPage />));
    await user.click(screen.getByRole('button', { name: 'Delete card' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Delete this card?')).not.toBeInTheDocument());
    expect(state.deleteCard).not.toHaveBeenCalled();
  });

  it('turns an action into a task in the backlog', async () => {
    const user = userEvent.setup();
    state.retro = query([card('a', 'action', { text: 'Fix the build' }), card('b', 'went_well')]);
    render(wrap(<SprintRetroPage />));
    // Only an action offers it.
    expect(screen.getAllByRole('button', { name: 'Make it a task' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Make it a task' }));
    const [title, handlers] = state.makeTask.mock.calls[0]!;
    expect(title).toBe('Fix the build');
    handlers.onSuccess();
    expect(state.toastSuccess).toHaveBeenCalledWith('Task created in the backlog');
    handlers.onError(new Error('x'));
    expect(state.toastError).toHaveBeenCalledWith('The task couldn’t be created.');
  });

  it('lets an admin change the card of someone else', () => {
    state.isAdmin = true;
    state.retro = query([card('a', 'went_well', { authorId: 'someone-else' })]);
    render(wrap(<SprintRetroPage />));
    expect(screen.getByRole('button', { name: 'Edit card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete card' })).toBeInTheDocument();
  });

  it('does not let a member change the card of someone else', () => {
    state.retro = query([card('a', 'went_well', { authorId: 'someone-else' })]);
    render(wrap(<SprintRetroPage />));
    expect(screen.queryByRole('button', { name: 'Edit card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete card' })).not.toBeInTheDocument();
  });

  it('is read-only for a reader, and without a signed-in user nothing is yours', () => {
    state.canWrite = false;
    state.userId = null;
    state.retro = query([card('a', 'action')]);
    render(wrap(<SprintRetroPage />));
    expect(screen.queryByRole('button', { name: /Add to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make it a task' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '0 votes' })).toBeDisabled();
  });
});
