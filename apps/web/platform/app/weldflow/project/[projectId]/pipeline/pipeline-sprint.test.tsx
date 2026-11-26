import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';

type DndProps = {
  onDragStart: (event: unknown) => void;
  onDragEnd: (event: unknown) => Promise<void>;
};

const state = vi.hoisted(() => ({
  dnd: null as null | DndProps,
  canWrite: true,
  isAdmin: true,
  allowed: new Set<string>(['projects:update']),
  search: '',
  replace: vi.fn(),
  delivery: {} as Record<string, unknown>,
  sprints: { isLoading: false, data: [] as unknown[] },
  updateDelivery: vi.fn(),
  listAllPages: vi.fn(),
  reorderTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  stageUpdate: vi.fn(),
  persist: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  createDialogProps: null as null | { open: boolean; onSave: (data: Record<string, unknown>) => void },
}));

vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: DndProps & Record<string, unknown>) => {
      state.dnd = props;
      return <actual.DndContext {...(props as object)} />;
    },
  };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useParams: () => ({ projectId: 'p1' }),
  usePathname: () => '/weldflow/project/p1/pipeline',
  useRouter: () => ({ replace: state.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (key: string) => state.allowed.has(key) }) }));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  useProjectPermissions: () => ({ canWrite: state.canWrite, isAdmin: state.isAdmin }),
}));
vi.mock('@/components/objects/task/use-task-data', () => ({ TASK_DELETED_EVENT: 'weld:task-deleted' }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelNavigationSource: () => undefined,
}));
vi.mock('@/app/weldflow/hooks/use-project-labels', () => {
  const labels: unknown[] = [];
  const setLabels = () => undefined;
  return { useProjectLabels: () => [labels, setLabels] };
});
vi.mock('@/components/entity-list', () => ({ FilterPills: () => null }));
vi.mock('@/app/weldcrm/task-dialog', () => ({
  TaskDialog: (props: { open: boolean; onSave: (data: Record<string, unknown>) => void }) => {
    state.createDialogProps = props;
    return props.open ? <div data-testid="task-dialog" /> : null;
  },
}));
vi.mock('@/app/weldflow/lib/persist-stage-change', () => ({ persistStageChange: (...args: unknown[]) => state.persist(...args) }));
vi.mock('@/app/weldflow/lib/api-client', () => ({
  tasksApi: {
    listAllPages: (...args: unknown[]) => state.listAllPages(...args),
    reorderTasks: (...args: unknown[]) => state.reorderTasks(...args),
    get: (...args: unknown[]) => state.getTask(...args),
    create: (...args: unknown[]) => state.createTask(...args),
  },
  membersApi: { list: vi.fn(async () => ({ success: true, data: [] })) },
  stagesApi: {
    list: vi.fn(async () => ({
      success: true,
      data: [
        { id: 'st1', name: 'Ready', color: '#94a3b8', systemStatus: 'todo' },
        { id: 'st2', name: 'Doing', color: '#93c5fd', systemStatus: 'in_progress' },
        { id: 'st3', name: 'Finished', color: '#34d399', systemStatus: 'done' },
      ],
    })),
    update: (...args: unknown[]) => state.stageUpdate(...args),
    reorder: vi.fn(async () => ({ success: true })),
  },
  labelsApi: { list: vi.fn(async () => ({ success: true, data: [] })), create: vi.fn() },
}));
vi.mock('./_components/sprint-bar', () => ({
  SprintBar: ({ sprint, onSprintChange }: { sprint: { id: string } | null; onSprintChange?: (id: string | null) => void }) => (
    <div data-testid="sprint-bar">
      <span>bar for {sprint?.id ?? 'no sprint'}</span>
      <button type="button" onClick={() => onSprintChange?.('P')}>
        pick P
      </button>
      <button type="button" onClick={() => onSprintChange?.(null)}>
        pick all
      </button>
    </div>
  ),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => state.delivery,
  useUpdateProjectDelivery: () => ({ mutateAsync: state.updateDelivery }),
  useProjectSprints: () => state.sprints,
}));

import Page, { PipelineView } from './page';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const wrap = (node: ReactNode) => <I18nProvider initialLanguage="en">{node}</I18nProvider>;

interface DeliveryOptions {
  sprints?: boolean;
  wip?: boolean;
  types?: boolean;
  wipLimits?: Record<string, number>;
  isLoading?: boolean;
  available?: boolean;
}

function deliveryOf(options: DeliveryOptions = {}) {
  return {
    available: options.available ?? true,
    isLoading: options.isLoading ?? false,
    usesSprints: options.sprints ?? false,
    usesWipLimits: options.wip ?? false,
    usesItemTypes: options.types ?? false,
    settings: {
      approach: 'scrum',
      sprintLengthDays: 14,
      itemTypes: { naming: 'pbi', featureLevel: false, enabled: [] },
      wipLimits: options.wipLimits ?? {},
      definitionOfDone: [],
    },
  };
}

function sprint(id: string, status: string): Sprint {
  return {
    id,
    projectId: 'p1',
    name: `Sprint ${id}`,
    goal: null,
    status,
    startDate: '2026-11-01',
    endDate: '2026-11-14',
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const tasks = [
  { id: 't1', number: 1, title: 'Alpha', stageId: 'st1', status: 'todo', type: 'bug', storyPoints: 5 },
  { id: 't2', number: 2, title: 'Beta', stageId: 'st1', status: 'todo', type: 'story', storyPoints: null, parentTaskId: 't1' },
  { id: 't3', number: 3, title: 'Gamma', stageId: 'st2', status: 'in_progress', type: 'story', storyPoints: 3 },
  { id: 't4', number: 4, title: 'Delta', stageId: 'st2', status: 'in_progress' },
];

async function showBoard(node: ReactNode) {
  const view = render(wrap(node));
  await screen.findByText('Alpha');
  return view;
}

async function drag(activeId: string, overId: string) {
  await act(async () => {
    state.dnd!.onDragStart({ active: { id: activeId } });
  });
  await act(async () => {
    await state.dnd!.onDragEnd({ active: { id: activeId }, over: { id: overId } });
  });
}

beforeEach(() => {
  state.dnd = null;
  state.canWrite = true;
  state.isAdmin = true;
  state.allowed = new Set(['projects:update']);
  state.search = '';
  state.replace.mockReset();
  state.delivery = deliveryOf();
  state.sprints = { isLoading: false, data: [] };
  state.updateDelivery.mockReset().mockResolvedValue({});
  state.listAllPages.mockReset().mockResolvedValue({ success: true, data: tasks });
  state.reorderTasks.mockReset().mockResolvedValue({ success: true });
  state.getTask.mockReset();
  state.createTask.mockReset();
  state.stageUpdate.mockReset().mockResolvedValue({ success: true });
  state.persist.mockReset().mockResolvedValue({ success: true, data: {} });
  state.toast.success.mockReset();
  state.toast.error.mockReset();
  state.toast.warning.mockReset();
  state.createDialogProps = null;
});

describe('Pipeline page (the sprint of the board)', () => {
  it('waits for the delivery setting before it loads the board', () => {
    state.delivery = deliveryOf({ isLoading: true });
    render(wrap(<Page />));
    expect(state.listAllPages).not.toHaveBeenCalled();
  });

  it('waits for the sprint list of a sprint project', () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: true, data: [] };
    render(wrap(<Page />));
    expect(state.listAllPages).not.toHaveBeenCalled();
  });

  it('shows all the tasks of a project that does not plan in sprints, without a sprint bar', async () => {
    await showBoard(<Page />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', undefined);
    expect(screen.queryByTestId('sprint-bar')).not.toBeInTheDocument();
  });

  it('opens on the active sprint by default and loads only its items', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('P', 'planned'), sprint('A', 'active')] };
    await showBoard(<Page />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', { sprintId: 'A' });
    expect(screen.getByText('bar for A')).toBeInTheDocument();
  });

  it('opens the sprint named in ?sprint=', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('P', 'planned'), sprint('A', 'active')] };
    state.search = 'sprint=P';
    await showBoard(<Page />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', { sprintId: 'P' });
    expect(screen.getByText('bar for P')).toBeInTheDocument();
  });

  it('shows all open work for ?sprint=all', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('A', 'active')] };
    state.search = 'sprint=all';
    await showBoard(<Page />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', undefined);
    expect(screen.getByText('bar for no sprint')).toBeInTheDocument();
  });

  it('puts the picked sprint in the URL, and all open work as all', async () => {
    const user = userEvent.setup();
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('A', 'active'), sprint('P', 'planned')] };
    await showBoard(<Page />);
    await user.click(screen.getByRole('button', { name: 'pick P' }));
    expect(state.replace).toHaveBeenCalledWith('/weldflow/project/p1/pipeline?sprint=P');
    await user.click(screen.getByRole('button', { name: 'pick all' }));
    expect(state.replace).toHaveBeenLastCalledWith('/weldflow/project/p1/pipeline?sprint=all');
  });

  it('shows no sprint bar for a sprint project without sprints, and loads all open work', async () => {
    state.delivery = deliveryOf({ sprints: true });
    await showBoard(<Page />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', undefined);
    expect(screen.queryByTestId('sprint-bar')).not.toBeInTheDocument();
  });
});

describe('PipelineView', () => {
  it('has no sprint bar inside the sprint page, and loads the items of its sprint', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('A', 'active')] };
    await showBoard(<PipelineView projectId="p1" sprintId="A" embedded />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', { sprintId: 'A' });
    expect(screen.queryByTestId('sprint-bar')).not.toBeInTheDocument();
  });

  it('ignores a sprint for a project that does not plan in sprints', async () => {
    await showBoard(<PipelineView projectId="p1" sprintId="A" />);
    expect(state.listAllPages).toHaveBeenCalledWith('p1', undefined);
  });

  it('puts a new task on the sprint of the board', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('A', 'active')] };
    state.createTask.mockResolvedValue({ success: true, data: { id: 't9', title: 'New one', stageId: 'st1', status: 'todo' } });
    await showBoard(<PipelineView projectId="p1" sprintId="A" embedded />);
    await act(async () => {
      state.createDialogProps!.onSave({ title: 'New one', status: 'st1' });
    });
    expect(state.createTask).toHaveBeenCalledWith('p1', expect.objectContaining({ sprintId: 'A', title: 'New one', stageId: 'st1' }));
    expect(await screen.findByText('New one')).toBeInTheDocument();
  });

  it('loads the items again when the sprint is started or completed on the board', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('A', 'planned')] };
    const view = await showBoard(<PipelineView projectId="p1" sprintId="A" />);
    expect(state.listAllPages).toHaveBeenCalledTimes(1);

    state.sprints = { isLoading: false, data: [sprint('A', 'active')] };
    view.rerender(wrap(<PipelineView projectId="p1" sprintId="A" />));
    await waitFor(() => expect(state.listAllPages).toHaveBeenCalledTimes(2));
  });

  it('keeps the sprint bar above the error when the items fail to load', async () => {
    state.delivery = deliveryOf({ sprints: true });
    state.sprints = { isLoading: false, data: [sprint('A', 'active')] };
    state.listAllPages.mockResolvedValue({ success: false, error: 'No access' });
    render(wrap(<PipelineView projectId="p1" sprintId="A" />));
    expect(await screen.findByRole('alert')).toHaveTextContent('No access');
    expect(screen.getByTestId('sprint-bar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the item type and the estimate on a card of a project with item types', async () => {
    state.delivery = deliveryOf({ types: true });
    await showBoard(<PipelineView projectId="p1" />);
    expect(screen.getByText('5 points')).toBeInTheDocument();
    expect(screen.getByText('3 points')).toBeInTheDocument();
    expect(screen.getByLabelText('Bug')).toBeInTheDocument();
    // A task with a parent reads as a subtask.
    expect(screen.getByLabelText('Subtask')).toBeInTheDocument();
  });

  it('shows no type or estimate for a project without item types', async () => {
    await showBoard(<PipelineView projectId="p1" />);
    expect(screen.queryByText('5 points')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bug')).not.toBeInTheDocument();
  });
});

describe('PipelineView WIP limits', () => {
  it('shows "n / limit" in the header, amber with a word from the limit up', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2, st2: 3, st3: 1 } });
    await showBoard(<PipelineView projectId="p1" />);
    // Ready holds 2 of 2: at the limit. Doing 2 of 3: below. Finished 0 of 1.
    const ready = screen.getByRole('button', { name: /^Ready/ });
    expect(within(ready).getByText('2 / 2')).toHaveAttribute('title', 'WIP limit: 2 of 2 items');
    expect(within(ready).getByText('At limit')).toBeInTheDocument();
    const doing = screen.getByRole('button', { name: /^Doing/ });
    expect(within(doing).getByText('2 / 3')).toBeInTheDocument();
    expect(within(doing).queryByText('At limit')).not.toBeInTheDocument();
    expect(screen.getByText('0 / 1')).toBeInTheDocument();
  });

  it('says over limit when a column holds more than its limit', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 1 } });
    await showBoard(<PipelineView projectId="p1" />);
    expect(screen.getByText('2 / 1')).toBeInTheDocument();
    expect(screen.getByText('Over limit')).toBeInTheDocument();
  });

  it('shows the plain count where there is no limit, also for a reader', async () => {
    state.canWrite = false;
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 1 } });
    await showBoard(<PipelineView projectId="p1" />);
    expect(screen.getByText('2 / 1')).toBeInTheDocument();
    expect(screen.queryByText('/ ', { exact: false, selector: 'h3' })).not.toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  it('ignores limits of a project that does not use them', async () => {
    state.delivery = deliveryOf({ wip: false, wipLimits: { st1: 1 } });
    await showBoard(<PipelineView projectId="p1" />);
    expect(screen.queryByText('2 / 1')).not.toBeInTheDocument();
  });
});

describe('PipelineView dropping a card', () => {
  it('moves the card and warns when the column is full, without refusing', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2 } });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t3', 'stage-st1');
    expect(state.persist).toHaveBeenCalledWith('p1', 't3', 'st1', 'in_progress', 'todo');
    expect(state.toast.success).toHaveBeenCalledWith('Task moved');
    expect(state.toast.warning).toHaveBeenCalledWith('Ready is over its WIP limit of 2. The item moved anyway.');
    // The card is in the full column now.
    expect(await screen.findByText('3 / 2')).toBeInTheDocument();
    expect(state.reorderTasks).not.toHaveBeenCalled();
  });

  it('does not warn when the column has room', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st2: 3 } });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t1', 'stage-st2');
    expect(state.toast.success).toHaveBeenCalledWith('Task moved');
    expect(state.toast.warning).not.toHaveBeenCalled();
  });

  it('does not warn for a column without a limit', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 1 } });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t1', 'stage-st3');
    expect(state.toast.success).toHaveBeenCalledWith('Task moved');
    expect(state.toast.warning).not.toHaveBeenCalled();
  });

  it('does not count the moved card itself against the limit', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st2: 2 } });
    await showBoard(<PipelineView projectId="p1" />);
    // Gamma is already in Doing: dropping it on a card of Doing only reorders.
    await drag('t3', 't4');
    expect(state.toast.warning).not.toHaveBeenCalled();
    expect(state.reorderTasks).toHaveBeenCalledWith('p1', expect.arrayContaining(['t3', 't4']));
  });

  it('saves the card order after a drop on a card of another column', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2 } });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t3', 't1');
    expect(state.persist).toHaveBeenCalledWith('p1', 't3', 'st1', 'in_progress', 'todo');
    expect(state.toast.warning).toHaveBeenCalled();
    expect(state.reorderTasks).toHaveBeenCalledTimes(1);
  });

  it('tells when saving the order fails after a move, and when it fails inside a column', async () => {
    state.reorderTasks.mockResolvedValue({ success: false });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t3', 't1');
    expect(state.toast.error).toHaveBeenCalledWith('Failed to reorder tasks');

    state.toast.error.mockReset();
    await drag('t2', 't1');
    expect(state.toast.error).toHaveBeenCalledWith('Failed to reorder tasks');
  });

  it('puts the board back and reloads when the move fails', async () => {
    state.persist.mockResolvedValue({ success: false });
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2 } });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t3', 'stage-st1');
    expect(state.toast.error).toHaveBeenCalledWith('Failed to update task');
    expect(state.toast.warning).not.toHaveBeenCalled();
    await waitFor(() => expect(state.listAllPages).toHaveBeenCalledTimes(2));
  });

  it('shows the next occurrence of a recurring task that was completed', async () => {
    state.persist.mockResolvedValue({ success: true, data: { nextTaskId: 't7' } });
    state.getTask.mockResolvedValue({ success: true, data: { id: 't7', title: 'Next round', stageId: 'st1', status: 'todo' } });
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t3', 'stage-st3');
    expect(state.getTask).toHaveBeenCalledWith('p1', 't7');
    expect(await screen.findByText('Next round')).toBeInTheDocument();
  });

  it('reorders the columns when a column is dropped on another column', async () => {
    await showBoard(<PipelineView projectId="p1" />);
    await drag('sortable-stage-st1', 'stage-st3');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Doing', 'Finished', 'Ready']);
    expect(state.persist).not.toHaveBeenCalled();
  });

  it('does nothing for a reader', async () => {
    state.canWrite = false;
    await showBoard(<PipelineView projectId="p1" />);
    await drag('t3', 'stage-st1');
    expect(state.persist).not.toHaveBeenCalled();
  });

  it('ignores a drop outside every column, and a drop of a card that is gone', async () => {
    await showBoard(<PipelineView projectId="p1" />);
    await act(async () => {
      state.dnd!.onDragStart({ active: { id: 't3' } });
    });
    await act(async () => {
      await state.dnd!.onDragEnd({ active: { id: 't3' }, over: null });
    });
    await act(async () => {
      await state.dnd!.onDragEnd({ active: { id: 'gone' }, over: { id: 'stage-st1' } });
    });
    expect(state.persist).not.toHaveBeenCalled();
  });
});

describe('PipelineView edit stage dialog', () => {
  async function openEditStage(label: RegExp) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: label }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit Stage' }));
    await screen.findByRole('dialog');
    return user;
  }

  it('shows the WIP limit field with the current limit to a project admin', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2 } });
    await showBoard(<PipelineView projectId="p1" />);
    await openEditStage(/^Ready/);
    expect(screen.getByLabelText('WIP limit')).toHaveValue(2);
    expect(screen.getByText(/The most items this column should hold/)).toBeInTheDocument();
  });

  it('has no WIP limit field for a member who is not an admin', async () => {
    state.isAdmin = false;
    await showBoard(<PipelineView projectId="p1" />);
    await openEditStage(/^Ready/);
    expect(screen.queryByLabelText('WIP limit')).not.toBeInTheDocument();
  });

  it('has no WIP limit field without the permission to update projects', async () => {
    state.allowed = new Set();
    await showBoard(<PipelineView projectId="p1" />);
    await openEditStage(/^Ready/);
    expect(screen.queryByLabelText('WIP limit')).not.toBeInTheDocument();
  });

  it('has no WIP limit field where agile delivery is not available', async () => {
    state.delivery = deliveryOf({ available: false });
    await showBoard(<PipelineView projectId="p1" />);
    await openEditStage(/^Ready/);
    expect(screen.queryByLabelText('WIP limit')).not.toBeInTheDocument();
  });

  it('saves a new limit with the rest of the delivery setting', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2 } });
    await showBoard(<PipelineView projectId="p1" />);
    const user = await openEditStage(/^Doing/);
    await user.type(screen.getByLabelText('WIP limit'), '4');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.updateDelivery).toHaveBeenCalledTimes(1));
    expect(state.updateDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ approach: 'scrum', wipLimits: { st1: 2, st2: 4 } }),
    );
    expect(state.stageUpdate).toHaveBeenCalledWith('p1', 'st2', expect.objectContaining({ name: 'Doing' }));
  });

  it('keeps a limit between 1 and the maximum', async () => {
    state.delivery = deliveryOf({ wip: true });
    await showBoard(<PipelineView projectId="p1" />);
    const user = await openEditStage(/^Doing/);
    await user.type(screen.getByLabelText('WIP limit'), '5000');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.updateDelivery).toHaveBeenCalled());
    expect(state.updateDelivery).toHaveBeenCalledWith(expect.objectContaining({ wipLimits: { st2: 999 } }));
  });

  it('removes the limit when the field is cleared', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st1: 2, st2: 3 } });
    await showBoard(<PipelineView projectId="p1" />);
    const user = await openEditStage(/^Doing/);
    await user.clear(screen.getByLabelText('WIP limit'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.updateDelivery).toHaveBeenCalled());
    expect(state.updateDelivery).toHaveBeenCalledWith(expect.objectContaining({ wipLimits: { st1: 2 } }));
  });

  it('does not save the delivery setting when the limit did not change', async () => {
    state.delivery = deliveryOf({ wip: true, wipLimits: { st2: 3 } });
    await showBoard(<PipelineView projectId="p1" />);
    const user = await openEditStage(/^Doing/);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.stageUpdate).toHaveBeenCalled());
    expect(state.updateDelivery).not.toHaveBeenCalled();
  });

  it('tells when the limit could not be saved', async () => {
    state.updateDelivery.mockRejectedValueOnce(new Error('boom'));
    state.delivery = deliveryOf({ wip: true });
    await showBoard(<PipelineView projectId="p1" />);
    const user = await openEditStage(/^Doing/);
    await user.type(screen.getByLabelText('WIP limit'), '2');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith('The WIP limit couldn’t be saved.'));
  });
});
