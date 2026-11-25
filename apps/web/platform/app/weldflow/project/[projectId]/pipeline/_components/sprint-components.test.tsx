import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { Sprint, SprintReport } from '@weldsuite/app-api-client/schemas/flow-agile';

const state = vi.hoisted(() => ({
  canWrite: true,
  push: vi.fn(),
  start: vi.fn(),
  startPending: false,
  complete: vi.fn(),
  completePending: false,
  report: { isLoading: false, isError: false, data: undefined as unknown },
  reportArgs: vi.fn(),
  sprints: { data: [] as unknown[] },
  items: { isLoading: false, isError: false, data: [] as unknown[] },
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push: state.push }),
}));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  useProjectPermissions: () => ({ canWrite: state.canWrite }),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useSprintReport: (...args: unknown[]) => {
    state.reportArgs(...args);
    return state.report;
  },
  useStartSprint: () => ({ mutateAsync: state.start, isPending: state.startPending }),
  useCompleteSprint: () => ({ mutateAsync: state.complete, isPending: state.completePending }),
  useProjectSprints: () => state.sprints,
}));
vi.mock('@/hooks/queries/use-flow-agile-sprint-queries', () => ({ useSprintItems: () => state.items }));

import { SprintBar, SprintStatusBadge } from './sprint-bar';
import { SprintActions } from './sprint-actions';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const wrap = (node: ReactNode) => <I18nProvider initialLanguage="en">{node}</I18nProvider>;

function sprint(id: string, status: string, extra: Partial<Sprint> = {}): Sprint {
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
    ...extra,
  };
}

function report(extra: Partial<SprintReport> = {}): SprintReport {
  return {
    committed: { points: 10, count: 4, taskIds: [] },
    completed: { points: 5, count: 2 },
    added: { points: 3, count: 1 },
    removed: { points: 1, count: 1 },
    carriedOver: { points: 8, count: 2, taskIds: ['t1', 't2'], toSprintId: null, toBacklog: 0 },
    goalMet: null,
    burndown: [],
    ...extra,
  };
}

beforeEach(() => {
  state.canWrite = true;
  state.push.mockReset();
  state.start.mockReset().mockResolvedValue({});
  state.startPending = false;
  state.complete.mockReset().mockResolvedValue({ data: { sprint: sprint('A', 'completed'), nextSprintId: 'P', report: report() } });
  state.completePending = false;
  state.report = { isLoading: false, isError: false, data: report() };
  state.reportArgs.mockReset();
  state.sprints = { data: [] };
  state.items = { isLoading: false, isError: false, data: [] };
  state.toastSuccess.mockReset();
  state.toastError.mockReset();
});

describe('SprintStatusBadge', () => {
  it('names a known status and falls back to the raw one', () => {
    render(wrap(<><SprintStatusBadge status="active" /><SprintStatusBadge status="mystery" /></>));
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('mystery')).toBeInTheDocument();
  });
});

describe('SprintBar', () => {
  it('shows the running sprint: dates, day, goal, progress, the added scope and its page', () => {
    render(
      wrap(
        <SprintBar
          projectId="p1"
          sprints={[sprint('A', 'active', { goal: 'Ship the board' })]}
          sprint={sprint('A', 'active', { goal: 'Ship the board' })}
          onSprintChange={vi.fn()}
        />,
      ),
    );
    expect(screen.getByRole('combobox', { name: 'Show on the Pipeline' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/Day \d+ of 14/)).toBeInTheDocument();
    expect(screen.getByText('Goal: Ship the board')).toBeInTheDocument();
    // 10 committed + 3 added - 1 removed.
    expect(screen.getByText('5 of 12 pts done')).toBeInTheDocument();
    expect(screen.getByText('+3 pts added after the start')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sprint page' })).toHaveAttribute('href', '/weldflow/project/p1/sprints/A');
    expect(screen.getByRole('button', { name: 'Complete sprint' })).toBeInTheDocument();
    expect(state.reportArgs).toHaveBeenCalledWith('p1', 'A');
  });

  it('leaves out the added line when nothing was added', () => {
    state.report = { isLoading: false, isError: false, data: report({ added: { points: 0, count: 0 } }) };
    render(wrap(<SprintBar projectId="p1" sprints={[sprint('A', 'active')]} sprint={sprint('A', 'active')} />));
    expect(screen.queryByText(/added after the start/)).not.toBeInTheDocument();
    // No picker without a change handler.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('shows nothing of the progress while the report loads', () => {
    state.report = { isLoading: true, isError: false, data: undefined };
    render(wrap(<SprintBar projectId="p1" sprints={[sprint('A', 'active')]} sprint={sprint('A', 'active')} />));
    expect(screen.queryByText(/pts done/)).not.toBeInTheDocument();
  });

  it('hints that a planned sprint still has to start, and has no dates to show', () => {
    render(wrap(<SprintBar projectId="p1" sprints={[sprint('P', 'planned', { startDate: null, endDate: null })]} sprint={sprint('P', 'planned', { startDate: null, endDate: null })} />));
    expect(screen.getByText('This sprint is planned. Start it to begin.')).toBeInTheDocument();
    expect(screen.getByText('No dates yet')).toBeInTheDocument();
    // A planned sprint has no numbers to load.
    expect(state.reportArgs).toHaveBeenCalledWith('p1', null);
  });

  it('shows only the picker for all open work', () => {
    render(wrap(<SprintBar projectId="p1" sprints={[sprint('A', 'active')]} sprint={null} onSprintChange={vi.fn()} />));
    expect(screen.getByRole('combobox')).toHaveTextContent('All open work');
    expect(screen.queryByRole('link', { name: 'Sprint page' })).not.toBeInTheDocument();
  });

  it('goes to the next sprint when the sprint is completed', async () => {
    const user = userEvent.setup();
    const onSprintChange = vi.fn();
    render(wrap(<SprintBar projectId="p1" sprints={[sprint('A', 'active')]} sprint={sprint('A', 'active')} onSprintChange={onSprintChange} />));
    await user.click(screen.getByRole('button', { name: 'Complete sprint' }));
    await screen.findByRole('dialog');
    const buttons = screen.getAllByRole('button', { name: 'Complete sprint' });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(onSprintChange).toHaveBeenCalledWith('P'));
  });
});

describe('SprintActions', () => {
  it('shows nothing for a reader', () => {
    state.canWrite = false;
    const { container } = render(wrap(<SprintActions projectId="p1" sprint={sprint('P', 'planned')} />));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing for a sprint that is over', () => {
    const { container } = render(wrap(<SprintActions projectId="p1" sprint={sprint('C', 'completed')} />));
    expect(container).toBeEmptyDOMElement();
  });

  it('starts a planned sprint', async () => {
    const user = userEvent.setup();
    render(wrap(<SprintActions projectId="p1" sprint={sprint('P', 'planned')} />));
    await user.click(screen.getByRole('button', { name: 'Start sprint' }));
    expect(state.start).toHaveBeenCalledWith({ id: 'P' });
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith('Sprint started'));
  });

  it('tells why a sprint could not start (409), or falls back to a general message', async () => {
    const user = userEvent.setup();
    state.start.mockRejectedValueOnce(new ApiError('Another sprint is already active', 409));
    render(wrap(<SprintActions projectId="p1" sprint={sprint('P', 'planned')} />));
    await user.click(screen.getByRole('button', { name: 'Start sprint' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Another sprint is already active'));

    state.start.mockRejectedValueOnce(new Error('boom'));
    await user.click(screen.getByRole('button', { name: 'Start sprint' }));
    await waitFor(() => expect(state.toastError).toHaveBeenLastCalledWith('The sprint couldn’t be started.'));
  });

  it('shows that the sprint is starting', () => {
    state.startPending = true;
    render(wrap(<SprintActions projectId="p1" sprint={sprint('P', 'planned')} />));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  });
});

describe('Complete sprint dialog', () => {
  const active = sprint('A', 'active', { goal: 'Ship the board' });
  const planned = sprint('P', 'planned', { name: 'Sprint P' });

  function open() {
    state.sprints = { data: [active, planned] };
    state.items = {
      isLoading: false,
      isError: false,
      data: [
        { id: 't1', number: 12, title: 'Task one', storyPoints: 3 },
        { id: 't2', number: null, title: 'Task two', storyPoints: null },
        { id: 't3', number: 14, title: 'Done task', storyPoints: 1 },
      ],
    };
  }

  async function openDialog(onCompleted = vi.fn()) {
    const user = userEvent.setup();
    render(wrap(<SprintActions projectId="p1" sprint={active} onCompleted={onCompleted} />));
    await user.click(screen.getByRole('button', { name: 'Complete sprint' }));
    await screen.findByRole('dialog');
    return { user, onCompleted };
  }

  const submit = (user: ReturnType<typeof userEvent.setup>) => {
    const buttons = screen.getAllByRole('button', { name: 'Complete sprint' });
    return user.click(buttons[buttons.length - 1]!);
  };

  it('shows the numbers and the unfinished items, and completes with the defaults', async () => {
    open();
    const { user, onCompleted } = await openDialog();

    expect(screen.getByText('Complete Sprint A')).toBeInTheDocument();
    expect(screen.getByText('8 points')).toBeInTheDocument();
    expect(screen.getByText('+3 pts')).toBeInTheDocument();
    expect(screen.getByText('Was the sprint goal met?')).toBeInTheDocument();
    expect(screen.getByText('Task one')).toBeInTheDocument();
    expect(screen.getByText('#12')).toBeInTheDocument();
    expect(screen.getByText('3 points')).toBeInTheDocument();
    expect(screen.queryByText('Done task')).not.toBeInTheDocument();

    await submit(user);
    expect(state.complete).toHaveBeenCalledWith({ id: 'A', input: { goalMet: true, moveTo: 'next', nextSprintId: 'P' } });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ nextSprintId: 'P' })));
    expect(state.toastSuccess).toHaveBeenCalledWith('Sprint completed');
    expect(state.push).not.toHaveBeenCalled();
  });

  it('records a missed goal, a per-item target and a new sprint', async () => {
    open();
    const { user } = await openDialog();

    await user.click(screen.getByLabelText('No'));
    await user.click(screen.getByRole('combobox', { name: 'Where does Task one go?' }));
    await user.click(await screen.findByRole('option', { name: 'Backlog' }));
    await user.click(screen.getByRole('combobox', { name: 'Next sprint' }));
    await user.click(await screen.findByRole('option', { name: 'A new sprint' }));

    await submit(user);
    expect(state.complete).toHaveBeenCalledWith({
      id: 'A',
      input: { goalMet: false, moveTo: 'next', items: [{ taskId: 't1', moveTo: 'backlog' }] },
    });
  });

  it('moves everything to the backlog and hides the next-sprint choice', async () => {
    open();
    const { user } = await openDialog();
    await user.click(screen.getByRole('combobox', { name: 'Move unfinished items to' }));
    await user.click(await screen.findByRole('option', { name: 'Backlog' }));
    expect(screen.queryByRole('combobox', { name: 'Next sprint' })).not.toBeInTheDocument();

    await submit(user);
    expect(state.complete).toHaveBeenCalledWith({ id: 'A', input: { goalMet: true, moveTo: 'backlog' } });
  });

  it('opens the retro when asked to', async () => {
    open();
    const { user, onCompleted } = await openDialog();
    await user.click(screen.getByLabelText('Open the retrospective for this sprint'));
    await submit(user);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldflow/project/p1/sprints/A/retro'));
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('says when everything is done and asks no goal question for a sprint without a goal', async () => {
    state.sprints = { data: [planned] };
    state.report = { isLoading: false, isError: false, data: report({ carriedOver: { points: 0, count: 0, taskIds: [], toSprintId: null, toBacklog: 0 } }) };
    const user = userEvent.setup();
    render(wrap(<SprintActions projectId="p1" sprint={sprint('A', 'active')} />));
    await user.click(screen.getByRole('button', { name: 'Complete sprint' }));
    expect(await screen.findByText('Everything in this sprint is done.')).toBeInTheDocument();
    expect(screen.queryByText('Was the sprint goal met?')).not.toBeInTheDocument();

    await submit(user);
    expect(state.complete).toHaveBeenCalledWith({ id: 'A', input: { moveTo: 'next', nextSprintId: 'P' } });
  });

  it('shows the API message when completing fails, and keeps the dialog open', async () => {
    open();
    state.complete.mockRejectedValueOnce(new ApiError('The sprint is not active', 409));
    const { user } = await openDialog();
    await submit(user);
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('The sprint is not active'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('falls back to a general message for an unexpected failure', async () => {
    open();
    state.complete.mockRejectedValueOnce(new Error('boom'));
    const { user } = await openDialog();
    await submit(user);
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('The sprint couldn’t be completed.'));
  });

  it('shows a loader for the numbers and keeps Complete off until they are there', async () => {
    open();
    state.report = { isLoading: true, isError: false, data: undefined };
    await openDialog();
    expect(screen.getByRole('status', { name: 'Loading the sprint’s numbers…' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Complete sprint' });
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });

  it('shows when the numbers could not be loaded', async () => {
    open();
    state.report = { isLoading: false, isError: true, data: undefined };
    await openDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('The sprint’s numbers couldn’t be loaded.');
  });

  it('tells while the unfinished items load or fail to load', async () => {
    open();
    state.items = { isLoading: true, isError: false, data: [] };
    const { user } = await openDialog();
    expect(screen.getByText('Loading the unfinished items…')).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('tells when the unfinished items could not be loaded', async () => {
    open();
    state.items = { isLoading: false, isError: true, data: [] };
    await openDialog();
    expect(screen.getByText(/couldn’t be loaded. They will follow the default./)).toBeInTheDocument();
  });

  it('cannot be closed while the sprint is being completed, and shows it', async () => {
    open();
    state.completePending = true;
    const { user } = await openDialog();
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Cancel', async () => {
    open();
    const { user } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
