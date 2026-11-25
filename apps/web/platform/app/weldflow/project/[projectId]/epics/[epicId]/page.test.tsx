import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import {
  deliveryFor,
  makeEpic,
  makeItem,
  makeSprint,
  renderApp,
} from '../../tasks/backlog/_components/backlog-test-fixtures';
import EpicPage from './page';
import { BurnupChart } from './_components/burnup-chart';
import { EpicItems } from './_components/epic-items';
import { EpicLinks } from './_components/epic-links';

const m = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  openPanel: vi.fn(),
  canWrite: true,
  delivery: null as unknown,
  epic: null as unknown,
  epics: [] as unknown[],
  sprints: [] as unknown[],
  items: null as unknown,
  links: null as unknown,
  createItem: vi.fn(),
  updateEpic: vi.fn(),
  refetchEpic: vi.fn(),
  refetchItems: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: vi.fn() } }));
vi.mock('@/lib/router', () => ({
  useParams: () => ({ projectId: 'p1', epicId: 'e1' }),
  useRouter: () => ({ replace: m.replace, push: m.push }),
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
// The real field is a rich-text editor; the page only needs its save callback.
vi.mock('@/components/task-detail/task-detail-content', () => ({
  DescriptionField: ({ onUpdate }: { onUpdate: (taskId: string, data: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => onUpdate('e1', { description: 'New text' })}>
      edit-description
    </button>
  ),
}));
vi.mock('@/components/objects/task/use-task-data', () => ({
  useTaskById: () => m.epic,
  useUpdateTask: () => ({ mutate: m.updateEpic }),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => m.delivery,
  useProjectEpics: () => ({ data: m.epics }),
  useProjectSprints: () => ({ data: m.sprints }),
}));
vi.mock('@/hooks/queries/use-flow-agile-backlog-queries', () => ({
  useEpicItems: () => m.items,
  useEpicLinks: () => m.links,
  useCreateItem: () => ({ mutateAsync: m.createItem }),
}));

function query(data: unknown, over: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, error: null, refetch: m.refetchEpic, ...over };
}

const epicTask = {
  id: 'e1',
  projectId: 'p1',
  type: 'epic',
  title: 'Checkout',
  number: 7,
  status: 'in_progress',
  dueDate: '2026-12-24T00:00:00.000Z',
  description: 'About checkout',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.canWrite = true;
  m.delivery = deliveryFor('scrum');
  m.epic = query(epicTask);
  m.epics = [makeEpic({ id: 'e1', items: 4, done: 1, points: 10, donePoints: 4 })];
  m.sprints = [makeSprint({ id: 's1', name: 'Sprint 1', status: 'active', startDate: '2026-11-02T00:00:00.000Z' })];
  m.items = {
    data: [
      makeItem({ id: 'a', title: 'Alpha', number: 1, sprintId: 's1', storyPoints: 3, status: 'done', completedDate: '2026-11-10T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' }),
      makeItem({ id: 'b', title: 'Beta', storyPoints: 5, epicId: 'e1', createdAt: '2026-11-05T00:00:00.000Z' }),
      makeItem({ id: 'c', title: 'Gamma', sprintId: 'old', storyPoints: null, status: 'cancelled' }),
    ],
    isLoading: false,
    isError: false,
    refetch: m.refetchItems,
  };
  m.links = { data: [], isLoading: false, isError: false };
  m.createItem.mockResolvedValue(undefined);
});

describe('EpicPage', () => {
  it('shows a loader while loading, and redirects when agile delivery is unavailable', () => {
    m.delivery = { ...deliveryFor('scrum'), isLoading: true };
    const first = renderApp(<EpicPage />);
    expect(m.replace).not.toHaveBeenCalled();
    first.unmount();
    m.delivery = deliveryFor('tasklist');
    renderApp(<EpicPage />);
    expect(m.replace).toHaveBeenCalledWith('/weldflow/project/p1/tasks');
  });

  it('shows a loader while the epic loads', () => {
    m.epic = query(undefined, { isLoading: true });
    renderApp(<EpicPage />);
    expect(screen.queryByRole('heading', { name: 'Checkout' })).toBeNull();
  });

  it.each([
    ['a 404', () => query(undefined, { isError: true, error: new ApiError('gone', 404) })],
    ['another project', () => query({ ...epicTask, projectId: 'other' })],
    ['an item that is no epic', () => query({ ...epicTask, type: 'bug' })],
  ])('says the epic does not exist for %s, and goes back to the backlog', async (_name, make) => {
    const user = userEvent.setup();
    m.epic = make();
    renderApp(<EpicPage />);
    expect(screen.getByText(/This epic doesn’t exist/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the backlog' }));
    expect(m.push).toHaveBeenCalledWith('/weldflow/project/p1/tasks/backlog');
  });

  it('offers a retry when the epic fails to load', async () => {
    const user = userEvent.setup();
    m.epic = query(undefined, { isError: true, error: new Error('network') });
    renderApp(<EpicPage />);
    expect(screen.getByText('The epic couldn’t be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(m.refetchEpic).toHaveBeenCalled();
  });

  it('shows the header, the progress and the items by sprint', async () => {
    const user = userEvent.setup();
    renderApp(<EpicPage />);
    expect(screen.getByRole('heading', { name: 'Checkout' })).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 points done')).toBeInTheDocument();
    expect(screen.getByText('1 of 4 done')).toBeInTheDocument();
    expect(screen.getByText('3 open items')).toBeInTheDocument();
    expect(screen.getByText('Grouped by sprint')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sprint 1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Earlier sprints' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Backlog' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Beta' }));
    expect(m.openPanel).toHaveBeenCalledWith({ type: 'task', id: 'b' });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(m.openPanel).toHaveBeenCalledWith({ type: 'task', id: 'e1' });
  });

  it('works out the progress from the items when the rollup is missing, and marks 100% as done', () => {
    m.epics = [];
    m.epic = query({ ...epicTask, status: 'done', dueDate: null });
    m.items = {
      data: [makeItem({ id: 'a', storyPoints: 2, status: 'done' })],
      isLoading: false,
      isError: false,
      refetch: m.refetchItems,
    };
    renderApp(<EpicPage />);
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('No date')).toBeInTheDocument();
  });

  it('counts items when nothing is estimated, and shows 0 for an empty epic', () => {
    m.epics = [makeEpic({ id: 'e1', items: 2, done: 1 })];
    const first = renderApp(<EpicPage />);
    expect(screen.getByText('50%')).toBeInTheDocument();
    first.unmount();
    m.epics = [];
    m.items = { data: [], isLoading: false, isError: false, refetch: m.refetchItems };
    renderApp(<EpicPage />);
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText(/No items yet/)).toBeInTheDocument();
  });

  it('shows a skeleton while the items load and an error with a retry when they fail', async () => {
    const user = userEvent.setup();
    m.items = { data: undefined, isLoading: true, isError: false, refetch: m.refetchItems };
    const first = renderApp(<EpicPage />);
    expect(screen.queryByText(/No items yet/)).toBeNull();
    first.unmount();
    m.items = { data: undefined, isLoading: false, isError: true, refetch: m.refetchItems };
    renderApp(<EpicPage />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(m.refetchItems).toHaveBeenCalled();
  });

  it('adds an item to the epic, and reports a failure', async () => {
    const user = userEvent.setup();
    renderApp(<EpicPage />);
    await user.type(screen.getByPlaceholderText('Add an item to this epic'), '/bug Broken{Enter}');
    await waitFor(() => expect(m.createItem).toHaveBeenCalledWith({ title: 'Broken', type: 'bug', epicId: 'e1' }));
    m.createItem.mockRejectedValueOnce(new ApiError('Not allowed', 403));
    await user.type(screen.getByPlaceholderText('Add an item to this epic'), 'Another{Enter}');
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('Not allowed'));
  });

  it('saves the description, and reports a failure', async () => {
    const user = userEvent.setup();
    renderApp(<EpicPage />);
    await user.click(screen.getByRole('button', { name: 'edit-description' }));
    const [, options] = m.updateEpic.mock.calls[0]!;
    expect(m.updateEpic.mock.calls[0]![0]).toMatchObject({ description: 'New text' });
    options.onError(new Error('x'));
    expect(m.toastError).toHaveBeenCalled();
  });

  it('shows a reader the description read-only, or says there is none', () => {
    m.canWrite = false;
    const first = renderApp(<EpicPage />);
    expect(screen.queryByPlaceholderText('Add an item to this epic')).toBeNull();
    expect(screen.queryByRole('button', { name: 'edit-description' })).toBeNull();
    expect(screen.getByText('About checkout')).toBeInTheDocument();
    first.unmount();
    m.epic = query({ ...epicTask, description: null });
    renderApp(<EpicPage />);
    expect(screen.getByText('No description.')).toBeInTheDocument();
  });

  it('does not group by sprint on a kanban project', () => {
    m.delivery = deliveryFor('kanban');
    renderApp(<EpicPage />);
    expect(screen.queryByText('Grouped by sprint')).toBeNull();
  });
});

describe('BurnupChart', () => {
  it('says so when there is nothing to chart', () => {
    renderApp(<BurnupChart items={[makeItem({ id: 'a', storyPoints: null })]} />);
    expect(screen.getByText('The burnup appears once the epic has estimated items.')).toBeInTheDocument();
  });

  it('charts the completed points against the scope, and notes scope growth', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    renderApp(
      <BurnupChart
        items={[
          makeItem({ id: 'a', storyPoints: 3, status: 'done', createdAt: new Date(now - 10 * day).toISOString(), completedDate: new Date(now - 2 * day).toISOString() }),
          makeItem({ id: 'b', storyPoints: 5, createdAt: new Date(now - 5 * day).toISOString() }),
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Burnup of the epic: 3 of 8 points done.' })).toBeInTheDocument();
    expect(screen.getByText('Scope grew by 5 points since the first item.')).toBeInTheDocument();
  });

  it('notes that the scope held', () => {
    renderApp(<BurnupChart items={[makeItem({ id: 'a', storyPoints: 3 })]} />);
    expect(screen.getByText('Scope hasn’t changed since the first item.')).toBeInTheDocument();
  });
});

describe('EpicItems', () => {
  it('lists the groups with their status badge and meta, and opens an item', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const item = makeItem({ id: 'a', title: 'Alpha', storyPoints: 3, status: 'in_progress', number: 3 });
    renderApp(
      <EpicItems
        naming="pbi"
        featureLevel={false}
        onOpen={onOpen}
        groups={[
          { id: 's1', kind: 'sprint', name: 'Sprint 1', status: 'active', items: [item] },
          { id: 's2', kind: 'sprint', name: null, status: 'planned', items: [makeItem({ id: 'z', title: 'Zed', status: 'weird' })] },
          { id: 'backlog', kind: 'backlog', name: null, status: null, items: [makeItem({ id: 'b', title: 'Beta', status: 'done' })] },
          { id: 'earlier', kind: 'earlier', name: null, status: null, items: [] },
        ]}
      />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1 item · 3 points')).toBeInTheDocument();
    expect(screen.getByText('weird')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Earlier sprints' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onOpen).toHaveBeenCalledWith(item);
  });
});

describe('EpicLinks', () => {
  const link = (id: string, type: string, title: string, code?: string) =>
    ({ id, target: { type, id: `t${id}`, title, status: 'open', code } }) as never;

  it('groups the linked risks and milestones, and links to the RAID log', () => {
    renderApp(
      <EpicLinks
        projectId="p1"
        loading={false}
        failed={false}
        links={[link('1', 'raid_item', 'Vendor delay', 'R-1'), link('2', 'milestone', 'Beta launch')]}
      />,
    );
    expect(screen.getByText('Risks and issues')).toBeInTheDocument();
    expect(screen.getByText('R-1')).toBeInTheDocument();
    expect(screen.getByText('Milestones')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the RAID log' })).toHaveAttribute('href', '/weldflow/project/p1/raid');
  });

  it('shows the loading, failed and empty states', () => {
    const first = renderApp(<EpicLinks projectId="p1" loading failed={false} links={[]} />);
    expect(screen.queryByText(/Nothing linked yet/)).toBeNull();
    first.unmount();
    const second = renderApp(<EpicLinks projectId="p1" loading={false} failed links={[]} />);
    expect(screen.getByText('The links couldn’t be loaded.')).toBeInTheDocument();
    second.unmount();
    renderApp(<EpicLinks projectId="p1" loading={false} failed={false} links={[]} />);
    expect(screen.getByText(/Nothing linked yet/)).toBeInTheDocument();
  });
});
