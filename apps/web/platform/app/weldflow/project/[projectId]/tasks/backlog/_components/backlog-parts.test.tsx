import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { ApiError } from '@weldsuite/api-client';
import { makeEnv, makeEpic, makeItem, makeSprint, renderApp } from './backlog-test-fixtures';
import { BacklogEnvProvider, useBacklogEnv, type BacklogEnv } from './backlog-context';
import { BacklogList } from './backlog-list';
import { PointsChip } from './backlog-row';
import { BulkBar } from './bulk-bar';
import { EpicsPanel, epicPercent } from './epics-panel';
import { ActiveSprintCard, PlannedSprintSection } from './sprint-sections';
import { BacklogBoard, BacklogFilterBanner, BacklogSection, DeleteBacklogItemsDialog, PlannedSprints } from './backlog-sections';

const m = vi.hoisted(() => ({
  startSprint: vi.fn(),
  updateSprint: vi.fn(),
  updateAgile: vi.fn(),
  reorder: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: m.toastSuccess } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useStartSprint: () => ({ mutate: m.startSprint, isPending: false }),
  useUpdateSprint: () => ({ mutate: m.updateSprint, isPending: false }),
  useUpdateTaskAgile: () => ({ mutateAsync: m.updateAgile }),
}));
vi.mock('@/hooks/queries/use-flow-agile-backlog-queries', () => ({
  agileBacklogKeys: { items: (id: string) => ['items', id] },
  useReorderItems: () => ({ mutateAsync: m.reorder }),
}));

beforeEach(() => vi.clearAllMocks());

const noop = async () => {};

function inEnv(env: BacklogEnv, ui: React.ReactNode) {
  return renderApp(
    <BacklogEnvProvider value={env}>
      <DndContext>{ui}</DndContext>
    </BacklogEnvProvider>,
  );
}

describe('backlog context', () => {
  it('refuses to be read outside the page', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Probe() {
      useBacklogEnv();
      return null;
    }
    expect(() => renderApp(<Probe />)).toThrow(/Backlog page/);
    spy.mockRestore();
  });
});

describe('PointsChip', () => {
  it('reads an estimate and a missing one', () => {
    renderApp(
      <>
        <PointsChip points={5} />
        <PointsChip points={null} />
      </>,
    );
    expect(screen.getByRole('img', { name: '5 story points' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Not estimated' })).toBeInTheDocument();
  });
});

describe('BacklogList rows and the item menu', () => {
  const sprints = [makeSprint({ id: 's1', name: 'Sprint 1', status: 'active' }), makeSprint({ id: 's2', name: 'Sprint 2' })];
  const epics = [makeEpic({ id: 'e1', title: 'Checkout' }), makeEpic({ id: 'e2', title: 'Search' })];
  const items = [
    makeItem({ id: 'a', title: 'Alpha', number: 4, storyPoints: 3, assigneeName: 'Ada Lovelace', epicId: 'e1', sprintId: 's1' }),
    makeItem({ id: 'b', title: 'Beta', status: 'done', assigneeAvatar: 'https://img.test/b.png', assigneeName: 'Bob' }),
  ];

  function renderList(over: Partial<BacklogEnv> = {}) {
    const env = makeEnv({
      sprints,
      epics,
      epicsById: new Map(epics.map((e) => [e.id, e])),
      ...over,
    });
    inEnv(env, <BacklogList sectionId="backlog" items={items} label="Backlog list" emptyText="nothing" />);
    return env;
  }

  it('shows the empty text for an empty section', () => {
    inEnv(makeEnv(), <BacklogList sectionId="backlog" items={[]} label="Backlog list" emptyText="nothing here" />);
    expect(screen.getByText('nothing here')).toBeInTheDocument();
  });

  it('renders the row parts and wires select, open and the epic chip', async () => {
    const user = userEvent.setup();
    const env = renderList();
    expect(screen.getByText('#4')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Assigned to Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Epic: Checkout' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(env.toggleSelected).toHaveBeenCalledWith('a');
    await user.click(screen.getByRole('button', { name: 'Open Alpha' }));
    expect(env.actions.open).toHaveBeenCalledWith('a');
  });

  it('has no select box or handle for a reader', () => {
    renderList({ canWrite: false });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drag Alpha' })).toBeNull();
  });

  it('opens the menu with the actions button and runs Open', async () => {
    const user = userEvent.setup();
    const env = renderList();
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(env.actions.open).toHaveBeenCalledWith('a');
  });

  it('changes the type from the menu', async () => {
    const user = userEvent.setup();
    const env = renderList();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change type' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Bug/ }));
    expect(env.actions.changeType).toHaveBeenCalledWith(['a'], 'bug');
  });

  it('moves to a sprint and back to the backlog', async () => {
    const user = userEvent.setup();
    const env = renderList();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to sprint' }));
    // Alpha sits in Sprint 1: it can go back to the backlog or to Sprint 2.
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sprint 2' }));
    expect(env.actions.moveToSprint).toHaveBeenCalledWith(['a'], 's2');
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to sprint' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Back to the backlog' }));
    expect(env.actions.moveToSprint).toHaveBeenCalledWith(['a'], null);
  });

  it('sets and clears the epic, turns into an epic and deletes', async () => {
    const user = userEvent.setup();
    const env = renderList();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set epic' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Search' }));
    expect(env.actions.setEpic).toHaveBeenCalledWith(['a'], 'e2');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set epic' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'No epic' }));
    expect(env.actions.setEpic).toHaveBeenCalledWith(['a'], null);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: /Turn into an epic/ }));
    expect(env.actions.turnIntoEpic).toHaveBeenCalledWith('a');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(env.actions.requestDelete).toHaveBeenCalledWith(['a']);
  });

  it('says there are no sprints or epics to pick when there are none', async () => {
    const user = userEvent.setup();
    renderList({ sprints: [], epics: [], usesSprints: true });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to sprint' }));
    expect(await screen.findByText('No sprints to move to')).toBeInTheDocument();
    await user.keyboard('{Escape}{Escape}');
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set epic' }));
    expect(await screen.findByText('No epics yet')).toBeInTheDocument();
  });

  it('offers only Open to a reader', async () => {
    const user = userEvent.setup();
    renderList({ canWrite: false });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    await user.keyboard('{Escape}');
  });

  it('applies a menu action to the whole selection and hides Turn into an epic then', async () => {
    const user = userEvent.setup();
    const env = renderList({ selected: new Set(['a', 'b']), targetsFor: () => ['a', 'b'], usesSprints: false });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Alpha' }));
    expect(screen.queryByRole('menuitem', { name: 'Move to sprint' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Turn into an epic/ })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(env.actions.requestDelete).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('BulkBar', () => {
  it('renders nothing without a selection or for a reader', () => {
    const clear = vi.fn();
    const first = inEnv(makeEnv(), <BulkBar ids={[]} onClear={clear} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    first.unmount();
    inEnv(makeEnv({ canWrite: false }), <BulkBar ids={['a']} onClear={clear} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('runs every action on the selected ids', async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    const env = makeEnv({
      sprints: [makeSprint({ id: 's1', name: 'Sprint 1' })],
      epics: [makeEpic({ id: 'e1', title: 'Checkout' })],
    });
    inEnv(env, <BulkBar ids={['a', 'b']} onClear={clear} />);
    expect(screen.getByText('2 items selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Set type/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Bug/ }));
    expect(env.actions.changeType).toHaveBeenCalledWith(['a', 'b'], 'bug');

    await user.click(screen.getByRole('button', { name: /Move to sprint/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sprint 1' }));
    expect(env.actions.moveToSprint).toHaveBeenCalledWith(['a', 'b'], 's1');
    await user.click(screen.getByRole('button', { name: /Move to sprint/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Back to the backlog' }));
    expect(env.actions.moveToSprint).toHaveBeenCalledWith(['a', 'b'], null);

    await user.click(screen.getByRole('button', { name: /Set epic/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Checkout' }));
    expect(env.actions.setEpic).toHaveBeenCalledWith(['a', 'b'], 'e1');
    await user.click(screen.getByRole('button', { name: /Set epic/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'No epic' }));
    expect(env.actions.setEpic).toHaveBeenCalledWith(['a', 'b'], null);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(env.actions.requestDelete).toHaveBeenCalledWith(['a', 'b']);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clear).toHaveBeenCalled();
  });

  it('has no sprint menu on a project without sprints', () => {
    inEnv(makeEnv({ usesSprints: false }), <BulkBar ids={['a']} onClear={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Move to sprint/ })).toBeNull();
  });
});

describe('EpicsPanel', () => {
  const epics = [
    makeEpic({ id: 'e1', title: 'Checkout', points: 10, donePoints: 4 }),
    makeEpic({ id: 'e2', title: 'Search', items: 4, done: 1 }),
  ];
  function panel(over: Partial<React.ComponentProps<typeof EpicsPanel>> = {}) {
    const props = {
      epics,
      loading: false,
      failed: false,
      selected: null as string | null,
      onSelect: vi.fn(),
      naming: 'pbi' as const,
      featureLevel: false,
      projectId: 'p1',
      canCreate: true,
      onCreate: vi.fn(async () => {}),
      ...over,
    };
    const view = renderApp(<EpicsPanel {...props} />);
    return { ...props, view };
  }

  it('computes the percentage from points, else items', () => {
    expect(epicPercent({ items: 0, done: 0, points: 0, donePoints: 0 })).toBe(0);
    expect(epicPercent({ items: 4, done: 1, points: 0, donePoints: 0 })).toBe(25);
    expect(epicPercent({ items: 4, done: 1, points: 10, donePoints: 4 })).toBe(40);
  });

  it('filters by an epic and by "without an epic", and opens the epic page', async () => {
    const user = userEvent.setup();
    const props = panel();
    await user.click(screen.getByRole('button', { name: /Checkout/ }));
    expect(props.onSelect).toHaveBeenCalledWith('e1');
    await user.click(screen.getByRole('button', { name: 'Items without an epic' }));
    expect(props.onSelect).toHaveBeenCalledWith('none');
    await user.click(screen.getByRole('button', { name: 'All items' }));
    expect(props.onSelect).toHaveBeenCalledWith(null);
    expect(screen.getByRole('link', { name: 'Open epic page: Checkout' })).toHaveAttribute('href', expect.stringContaining('e1'));
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('clears the filter when the selected epic is clicked again', async () => {
    const user = userEvent.setup();
    const props = panel({ selected: 'e1' });
    await user.click(screen.getByRole('button', { name: /Checkout/ }));
    expect(props.onSelect).toHaveBeenCalledWith(null);
  });

  it('shows the failed and empty states', () => {
    const first = panel({ failed: true, epics: [] });
    expect(screen.getByText('The epics couldn’t be loaded.')).toBeInTheDocument();
    first.view.unmount();
    const second = panel({ epics: [] });
    expect(screen.getByText(/No epics yet/)).toBeInTheDocument();
    second.view.unmount();
    panel({ loading: true, epics: [] });
    expect(screen.queryByText(/No epics yet/)).toBeNull();
  });

  it('creates an epic by title, and keeps the title when it fails', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce(undefined);
    panel({ onCreate });
    await user.click(screen.getByRole('button', { name: 'New epic' }));
    const input = screen.getByPlaceholderText('Epic title');
    await user.type(input, '   {Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, 'Payments{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Payments');
    expect(screen.getByPlaceholderText('Epic title')).toHaveValue('Payments');
    await user.type(screen.getByPlaceholderText('Epic title'), '{Enter}');
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(screen.queryByPlaceholderText('Epic title')).toBeNull();
  });

  it('closes the form with Escape', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByRole('button', { name: 'New epic' }));
    await user.type(screen.getByPlaceholderText('Epic title'), '{Escape}');
    expect(screen.queryByPlaceholderText('Epic title')).toBeNull();
  });

  it('hides the add button when the user cannot create', () => {
    panel({ canCreate: false });
    expect(screen.queryByRole('button', { name: 'New epic' })).toBeNull();
  });
});

describe('Sprint sections', () => {
  const sprintDates = { startDate: '2026-11-02T00:00:00.000Z', endDate: '2099-11-16T00:00:00.000Z' };

  it('summarises the active sprint with its goal, progress and a link to the board', () => {
    const items = [makeItem({ id: 'a', storyPoints: 3, status: 'done' }), makeItem({ id: 'b', storyPoints: 5 })];
    inEnv(
      makeEnv(),
      <ActiveSprintCard sprint={makeSprint({ id: 's1', name: 'Sprint 1', status: 'active', goal: 'Ship it', ...sprintDates })} items={items} projectId="p1" canWrite />,
    );
    expect(screen.getByRole('heading', { name: 'Sprint 1' })).toBeInTheDocument();
    expect(screen.getByText('Goal: Ship it')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38');
    expect(screen.getByRole('link', { name: 'Open board' })).toHaveAttribute('href', '/weldflow/project/p1/sprints/s1');
  });

  it.each([
    ['2000-01-01T00:00:00.000Z', 'Ended'],
    [new Date().toISOString(), 'Ends today'],
  ])('labels an active sprint ending %s', (endDate, text) => {
    inEnv(
      makeEnv(),
      <ActiveSprintCard sprint={makeSprint({ id: 's1', status: 'active', endDate, startDate: '1999-12-01T00:00:00.000Z' })} items={[]} projectId="p1" canWrite={false} />,
    );
    expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
  });

  function planned(over: { forecast?: number | null; activeSprint?: ReturnType<typeof makeSprint>; canWrite?: boolean; goal?: string | null } = {}) {
    const sprint = makeSprint({ id: 's2', name: 'Sprint 2', goal: over.goal ?? 'Old goal', ...sprintDates });
    inEnv(
      makeEnv(),
      <PlannedSprintSection
        sprint={sprint}
        items={[makeItem({ id: 'a', storyPoints: 8 })]}
        forecast={over.forecast === undefined ? 5 : over.forecast}
        activeSprint={over.activeSprint}
        projectId="p1"
        canWrite={over.canWrite ?? true}
      >
        <p>children</p>
      </PlannedSprintSection>,
    );
  }

  it('starts the sprint and reports success and a refusal', async () => {
    const user = userEvent.setup();
    planned();
    await user.click(screen.getByRole('button', { name: 'Start sprint' }));
    const [vars, options] = m.startSprint.mock.calls[0]!;
    expect(vars).toEqual({ id: 's2' });
    options.onSuccess();
    expect(m.toastSuccess).toHaveBeenCalledWith('Sprint 2 started');
    options.onError(new ApiError('Another sprint is active', 409));
    expect(m.toastError).toHaveBeenCalledWith('Another sprint is active');
    options.onError(new Error('boom'));
    expect(m.toastError).toHaveBeenLastCalledWith('The sprint couldn’t be started.');
  });

  it('blocks Start while another sprint is active', () => {
    planned({ activeSprint: makeSprint({ id: 's1', name: 'Sprint 1', status: 'active' }) });
    expect(screen.getByRole('button', { name: 'Start sprint' })).toBeDisabled();
    expect(screen.getByText('Complete Sprint 1 first')).toBeInTheDocument();
  });

  it('saves a changed goal on blur, clears it with an empty one, and skips an unchanged one', async () => {
    const user = userEvent.setup();
    planned();
    const goal = screen.getByLabelText('Sprint goal');
    await user.click(goal);
    await user.tab();
    expect(m.updateSprint).not.toHaveBeenCalled();
    await user.clear(goal);
    await user.type(goal, 'New goal{Enter}');
    const [vars, options] = m.updateSprint.mock.calls[0]!;
    expect(vars).toEqual({ id: 's2', input: { goal: 'New goal' } });
    options.onError(new Error('x'));
    expect(m.toastError).toHaveBeenCalled();
    await user.clear(goal);
    await user.tab();
    expect(m.updateSprint.mock.calls[1]![0]).toEqual({ id: 's2', input: { goal: null } });
  });

  it('shows over the forecast', () => {
    planned({ forecast: 5 });
    expect(screen.getByText('Over the forecast')).toBeInTheDocument();
  });

  it('shows within the forecast', () => {
    planned({ forecast: 20 });
    expect(screen.getByText('Within the forecast')).toBeInTheDocument();
  });

  it('shows the no-forecast hint', () => {
    planned({ forecast: null });
    expect(screen.getByText(/No forecast yet/)).toBeInTheDocument();
  });

  it('collapses, and a reader cannot start or edit the goal', async () => {
    const user = userEvent.setup();
    planned({ canWrite: false });
    expect(screen.queryByRole('button', { name: 'Start sprint' })).toBeNull();
    expect(screen.getByLabelText('Sprint goal')).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Collapse Sprint 2' }));
    expect(screen.queryByText('children')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Sprint 2' }));
    expect(screen.getByText('children')).toBeInTheDocument();
  });
});

describe('Backlog sections', () => {
  const create = vi.fn((_sprintId: string | null) => vi.fn(noop));
  const baseCreate = { canWrite: true, types: ['epic', 'story', 'bug'] as never[], naming: 'pbi' as const, featureLevel: false, createInSection: create };

  it('lists the backlog with its totals, the unestimated hint and the quick create', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(noop);
    create.mockReturnValue(onCreate);
    inEnv(
      makeEnv(),
      <BacklogSection items={[makeItem({ id: 'a', storyPoints: 2 }), makeItem({ id: 'b' })]} usesSprints filtering={false} {...baseCreate} />,
    );
    expect(screen.getByText(/2 items · 2 points estimated/)).toBeInTheDocument();
    expect(screen.getByText('1 item has no estimate')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New item title'), '/bug Broken link{Enter}');
    expect(create).toHaveBeenCalledWith(null);
    expect(onCreate).toHaveBeenCalledWith({ title: 'Broken link', type: 'bug' });
  });

  it('uses the kanban hint and the no-matches text', () => {
    inEnv(makeEnv(), <BacklogSection items={[]} usesSprints={false} filtering {...baseCreate} />);
    expect(screen.getByText('Ordered by priority. Drag to reorder.')).toBeInTheDocument();
    expect(screen.getByText('No items match.')).toBeInTheDocument();
  });

  it('hides the hint and quick create for a reader', () => {
    inEnv(makeEnv({ canWrite: false }), <BacklogSection items={[]} usesSprints filtering={false} {...baseCreate} canWrite={false} />);
    expect(screen.queryByLabelText('New item title')).toBeNull();
    expect(screen.getByText('The backlog is empty.')).toBeInTheDocument();
  });

  it('renders each planned sprint with its own quick create', () => {
    const sprints = [makeSprint({ id: 's2', name: 'Sprint 2' }), makeSprint({ id: 's3', name: 'Sprint 3' })];
    inEnv(
      makeEnv(),
      <PlannedSprints
        sprints={sprints}
        sections={{ s2: [makeItem({ id: 'a', sprintId: 's2' })] }}
        forecast={null}
        activeSprint={undefined}
        projectId="p1"
        {...baseCreate}
      />,
    );
    expect(screen.getByPlaceholderText('Add an item to Sprint 2')).toBeInTheDocument();
    expect(screen.getByText('Nothing planned yet. Drag items in from the backlog.')).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith('s3');
  });

  it('confirms a delete of one or several items', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(noop);
    const onCancel = vi.fn();
    const byId = new Map([['a', makeItem({ id: 'a', title: 'Alpha' })]]);
    const view = renderApp(<DeleteBacklogItemsDialog pendingDelete={['a']} itemsById={byId} loading={false} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByText(/“Alpha” and its subtasks/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    view.unmount();
    renderApp(<DeleteBacklogItemsDialog pendingDelete={['a', 'b']} itemsById={byId} loading={false} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByText('Delete 2 items?')).toBeInTheDocument();
  });

  it('renders no dialog when nothing is pending', () => {
    renderApp(<DeleteBacklogItemsDialog pendingDelete={null} itemsById={new Map()} loading={false} onCancel={vi.fn()} onConfirm={noop} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('names the filter, or no epic, and clears it', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const view = renderApp(<BacklogFilterBanner epicId="e1" epicTitle="Checkout" onClear={onClear} />);
    expect(screen.getByText('Showing items of Checkout')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(onClear).toHaveBeenCalled();
    view.unmount();
    renderApp(<BacklogFilterBanner epicId="none" epicTitle={undefined} onClear={onClear} />);
    expect(screen.getByText('Showing items without an epic')).toBeInTheDocument();
  });

  it('renders nothing without a filter', () => {
    const { container } = renderApp(<BacklogFilterBanner epicId={null} epicTitle={undefined} onClear={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lays out the board: active sprint, planned sprints and the backlog', () => {
    const active = makeSprint({ id: 's1', name: 'Sprint 1', status: 'active' });
    const planned = makeSprint({ id: 's2', name: 'Sprint 2' });
    const sections = { s1: [makeItem({ id: 'a', sprintId: 's1' })], s2: [], backlog: [makeItem({ id: 'b' })] };
    inEnv(
      makeEnv(),
      <BacklogBoard
        projectId="p1"
        sections={sections}
        itemsById={new Map(Object.values(sections).flat().map((i) => [i.id, i]))}
        allSprints={[active, planned]}
        usesSprints
        activeSprint={active}
        plannedSprints={[planned]}
        forecast={null}
        filtering={false}
        {...baseCreate}
      />,
    );
    expect(within(screen.getByRole('region', { name: 'Sprint 1' })).getByText('Open board')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sprint 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
  });

  it('lays out the board without sprints', () => {
    const sections = { backlog: [makeItem({ id: 'b' })] };
    inEnv(
      makeEnv({ usesSprints: false }),
      <BacklogBoard
        projectId="p1"
        sections={sections}
        itemsById={new Map([['b', sections.backlog[0]!]])}
        allSprints={[]}
        usesSprints={false}
        activeSprint={undefined}
        plannedSprints={[]}
        forecast={null}
        filtering={false}
        {...baseCreate}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start sprint' })).toBeNull();
  });
});
