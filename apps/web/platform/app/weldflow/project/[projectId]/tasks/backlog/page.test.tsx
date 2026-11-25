import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { deliveryFor, makeEpic, makeItem, makeSprint, renderApp } from './_components/backlog-test-fixtures';
import BacklogPage from './page';

const m = vi.hoisted(() => ({
  replace: vi.fn(),
  openPanel: vi.fn(),
  canWrite: true,
  delivery: null as unknown,
  items: null as unknown,
  sprints: [] as unknown[],
  epics: [] as unknown[],
  epicsState: { isLoading: false, isError: false },
  createItem: vi.fn(),
  deleteItems: vi.fn(),
  deletePending: false,
  createSprint: vi.fn(),
  bulkUpdate: vi.fn(),
  refetch: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: m.toastSuccess } }));
vi.mock('@/lib/router', () => ({
  useParams: () => ({ projectId: 'p1' }),
  useRouter: () => ({ replace: m.replace, push: vi.fn() }),
  usePathname: () => '/weldflow/project/p1/tasks/backlog',
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  useProjectPermissions: () => ({ canWrite: m.canWrite }),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: m.openPanel }) }));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => m.delivery,
  useProjectSprints: () => ({ data: m.sprints }),
  useProjectEpics: () => ({ data: m.epics, ...m.epicsState }),
  useCreateSprint: () => ({ mutate: m.createSprint, isPending: false }),
  useBulkUpdateTaskAgile: () => ({ mutateAsync: m.bulkUpdate }),
  useUpdateTaskAgile: () => ({ mutateAsync: vi.fn() }),
  useStartSprint: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSprint: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-flow-agile-backlog-queries', () => ({
  agileBacklogKeys: { items: (id: string) => ['items', id] },
  useBacklogItems: () => m.items,
  useCreateItem: () => ({ mutateAsync: m.createItem }),
  useDeleteItems: () => ({ mutateAsync: m.deleteItems, isPending: m.deletePending }),
  useReorderItems: () => ({ mutateAsync: vi.fn() }),
}));

const sprintItem = makeItem({ id: 'a', title: 'Alpha', sprintId: 's1', storyPoints: 3, epicId: 'e1', position: 0 });
const backlogItem = makeItem({ id: 'b', title: 'Beta', position: 0 });
const backlogItem2 = makeItem({ id: 'c', title: 'Gamma', position: 1, type: 'bug' });

function itemsQuery(data: unknown[] | undefined, over: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, refetch: m.refetch, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.canWrite = true;
  m.delivery = deliveryFor('scrum');
  m.items = itemsQuery([sprintItem, backlogItem, backlogItem2]);
  m.sprints = [makeSprint({ id: 's1', name: 'Sprint 1', status: 'active' }), makeSprint({ id: 's2', name: 'Sprint 2', status: 'planned' })];
  m.epics = [makeEpic({ id: 'e1', title: 'Checkout' })];
  m.epicsState = { isLoading: false, isError: false };
  m.createItem.mockResolvedValue(undefined);
  m.deleteItems.mockResolvedValue(undefined);
  m.bulkUpdate.mockResolvedValue(undefined);
  m.deletePending = false;
});

describe('BacklogPage', () => {
  it('shows a loader while the delivery model loads, without redirecting', () => {
    m.delivery = { ...deliveryFor('scrum'), isLoading: true };
    renderApp(<BacklogPage />);
    expect(m.replace).not.toHaveBeenCalled();
    expect(screen.queryByText('Backlog')).toBeNull();
  });

  it('sends a task list, or an edition without agile delivery, to the list', () => {
    m.delivery = deliveryFor('tasklist');
    renderApp(<BacklogPage />);
    expect(m.replace).toHaveBeenCalledWith('/weldflow/project/p1/tasks');
  });

  it('shows the sprints, the backlog and the epics of a scrum project', () => {
    renderApp(<BacklogPage />);
    expect(screen.getByRole('region', { name: 'Sprint 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sprint 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Epics' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'List' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open Beta' })).toBeInTheDocument();
  });

  it('has no sprint sections or new-sprint button on a kanban project', () => {
    m.delivery = deliveryFor('kanban');
    renderApp(<BacklogPage />);
    expect(screen.queryByRole('button', { name: 'New sprint' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sprint 2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Beta' })).toBeInTheDocument();
  });

  it('hides the new-sprint button for a reader', () => {
    m.canWrite = false;
    renderApp(<BacklogPage />);
    expect(screen.queryByRole('button', { name: 'New sprint' })).toBeNull();
  });

  it('creates the next sprint and reports the result', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('button', { name: 'New sprint' }));
    const [draft, options] = m.createSprint.mock.calls[0]!;
    expect(draft.name).toMatch(/^Sprint \d+$/);
    options.onSuccess();
    expect(m.toastSuccess).toHaveBeenCalledWith('Sprint created');
    options.onError(new ApiError('Name taken', 409));
    expect(m.toastError).toHaveBeenCalledWith('Name taken');
  });

  it('shows the loader while the items load', () => {
    m.items = itemsQuery(undefined, { isLoading: true });
    renderApp(<BacklogPage />);
    expect(screen.queryByRole('heading', { name: 'Backlog' })).toBeNull();
  });

  it('shows an error with a retry when the items fail to load', async () => {
    const user = userEvent.setup();
    m.items = itemsQuery(undefined, { isError: true });
    renderApp(<BacklogPage />);
    expect(screen.getByText('The backlog couldn’t be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(m.refetch).toHaveBeenCalled();
  });

  it('shows the empty state for an empty backlog', () => {
    m.items = itemsQuery([]);
    renderApp(<BacklogPage />);
    expect(screen.getByText('The backlog is empty')).toBeInTheDocument();
  });

  it('filters by the search text, and shows no empty state while filtering', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.type(screen.getAllByPlaceholderText('Search items')[0]!, 'Beta');
    expect(screen.getByRole('button', { name: 'Open Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Gamma' })).toBeNull();
    await user.clear(screen.getAllByPlaceholderText('Search items')[0]!);
    await user.type(screen.getAllByPlaceholderText('Search items')[0]!, 'zzz');
    expect(screen.queryByText('The backlog is empty')).toBeNull();
  });

  it('filters by an epic, creates in it, and clears the filter', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('button', { name: /Checkout/ }));
    expect(screen.getByText('Showing items of Checkout')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Beta' })).toBeNull();
    await user.type(screen.getAllByLabelText('New item title')[0]!, 'Child{Enter}');
    await waitFor(() => expect(m.createItem).toHaveBeenCalled());
    expect(m.createItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Child', epicId: 'e1' }));
    await user.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(screen.queryByText('Showing items of Checkout')).toBeNull();
  });

  it('filters by "without an epic"', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('button', { name: 'Items without an epic' }));
    expect(screen.getByText('Showing items without an epic')).toBeInTheDocument();
    await user.type(screen.getAllByLabelText('New item title')[0]!, 'Loose{Enter}');
    await waitFor(() => expect(m.createItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Loose', epicId: null })));
  });

  it('quick creates with a /bug prefix in the backlog and in a sprint', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.type(screen.getByPlaceholderText('Add an item'), '/bug Crash on save{Enter}');
    await waitFor(() => expect(m.createItem).toHaveBeenCalled());
    expect(m.createItem).toHaveBeenCalledWith({ title: 'Crash on save', type: 'bug', sprintId: null, epicId: null });
    await user.type(screen.getByPlaceholderText('Add an item to Sprint 2'), 'Planned one{Enter}');
    await waitFor(() => expect(m.createItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Planned one', sprintId: 's2' })));
  });

  it('tells the user when an item cannot be created, and keeps the text', async () => {
    const user = userEvent.setup();
    m.createItem.mockRejectedValueOnce(new ApiError('No permission', 403));
    renderApp(<BacklogPage />);
    await user.type(screen.getByPlaceholderText('Add an item'), 'Nope{Enter}');
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('No permission'));
    expect(screen.getByPlaceholderText('Add an item')).toHaveValue('Nope');
  });

  it('creates an epic from the panel and reports a failure', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('button', { name: 'New epic' }));
    await user.type(screen.getByPlaceholderText('Epic title'), 'Payments{Enter}');
    await waitFor(() => expect(m.createItem).toHaveBeenCalledWith({ title: 'Payments', type: 'epic' }));
    m.createItem.mockRejectedValueOnce(new Error('x'));
    await user.click(screen.getByRole('button', { name: 'New epic' }));
    await user.type(screen.getByPlaceholderText('Epic title'), 'Again{Enter}');
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('The epic couldn’t be created.'));
  });

  it('opens an item in the panel', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('button', { name: 'Open Beta' }));
    expect(m.openPanel).toHaveBeenCalledWith({ type: 'task', id: 'b' });
  });

  it('changes the type of one item from its menu', async () => {
    renderApp(<BacklogPage />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Change type' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Bug/ }));
    await waitFor(() => expect(m.bulkUpdate).toHaveBeenCalledWith({ taskIds: ['b'], input: { type: 'bug' } }));
    expect(m.toastSuccess).not.toHaveBeenCalled();
  });

  it('moves an item to a sprint, sets its epic and turns it into an epic', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to sprint' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sprint 2' }));
    await waitFor(() => expect(m.bulkUpdate).toHaveBeenCalledWith({ taskIds: ['b'], input: { sprintId: 's2' } }));

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set epic' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Checkout' }));
    await waitFor(() => expect(m.bulkUpdate).toHaveBeenCalledWith({ taskIds: ['b'], input: { epicId: 'e1' } }));

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: /Turn into an epic/ }));
    await waitFor(() =>
      expect(m.bulkUpdate).toHaveBeenCalledWith({ taskIds: ['b'], input: { type: 'epic', sprintId: null, epicId: null } }),
    );
  });

  it('tells the user when an update is refused', async () => {
    const user = userEvent.setup();
    m.bulkUpdate.mockRejectedValueOnce(new ApiError('An epic cannot be in a sprint', 409));
    renderApp(<BacklogPage />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: /Turn into an epic/ }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('An epic cannot be in a sprint'));
  });

  it('selects items and updates them in bulk, with a summary toast', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    expect(screen.getByText('2 items selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Set epic/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Checkout' }));
    await waitFor(() => expect(m.bulkUpdate).toHaveBeenCalledWith({ taskIds: ['b', 'c'], input: { epicId: 'e1' } }));
    await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledWith('2 items updated'));
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
  });

  it('reports a failed bulk update, and clears the selection by hand', async () => {
    const user = userEvent.setup();
    m.bulkUpdate.mockRejectedValueOnce(new Error('x'));
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    await user.click(screen.getByRole('button', { name: /Set type/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Task/ }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('Some items couldn’t be updated.'));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('applies a row menu action to the whole selection, then unselects an item again', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByText('Delete 2 items?')).toBeInTheDocument();
  });

  it('deletes after a confirmation, and reports success', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByText(/“Beta” and its subtasks/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(m.deleteItems).toHaveBeenCalledWith(['b']));
    expect(m.toastSuccess).toHaveBeenCalledWith('Deleted');
    await waitFor(() => expect(screen.queryByText(/“Beta” and its subtasks/)).toBeNull());
  });

  it('cancels a delete without calling the API', async () => {
    const user = userEvent.setup();
    renderApp(<BacklogPage />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(m.deleteItems).not.toHaveBeenCalled();
  });

  it('reports a failed delete', async () => {
    const user = userEvent.setup();
    m.deleteItems.mockRejectedValueOnce(new Error('x'));
    renderApp(<BacklogPage />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('The items couldn’t be deleted.'));
  });

  it('shows the epics panel failing to load', () => {
    m.epicsState = { isLoading: false, isError: true };
    m.epics = [];
    renderApp(<BacklogPage />);
    expect(screen.getByText('The epics couldn’t be loaded.')).toBeInTheDocument();
  });
});
