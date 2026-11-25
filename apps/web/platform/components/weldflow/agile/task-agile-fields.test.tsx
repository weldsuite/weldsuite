import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { TaskRow } from '@weldsuite/app-api-client/domains/tasks';

const state = vi.hoisted(() => ({
  available: true,
  settings: {} as Record<string, unknown>,
  epics: [] as unknown[],
  sprints: [] as unknown[],
  mutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, className }: { href: string; children?: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', async () => {
  const { deliveryModel } = await import('@/app/weldflow/lib/delivery');
  return {
    useProjectDelivery: () => ({
      ...deliveryModel({ delivery: state.settings }, state.available),
      isLoading: false,
    }),
    useProjectEpics: () => ({ data: state.epics }),
    useProjectSprints: () => ({ data: state.sprints }),
    useUpdateTaskAgile: () => ({ mutate: state.mutate, isPending: false }),
  };
});

import { TaskAgileFields, TaskAgileSections, epicPageHref } from './task-agile-fields';

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return { id: 't1', title: 'Login', projectId: 'p1', type: 'story', ...overrides } as TaskRow;
}

function renderFields(row: TaskRow) {
  return render(
    <I18nProvider initialLanguage="en">
      <TaskAgileFields task={row} />
      <TaskAgileSections task={row} />
    </I18nProvider>,
  );
}

const lastSave = () => state.mutate.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  state.available = true;
  state.settings = {
    approach: 'scrum',
    itemTypes: { naming: 'pbi', featureLevel: false, enabled: ['epic', 'story', 'bug', 'task', 'spike', 'subtask'] },
    definitionOfDone: ['Code reviewed', 'Tests pass'],
  };
  state.epics = [
    { id: 'e1', title: 'Onboarding', type: 'epic' },
    { id: 'f1', title: 'Sign up', type: 'feature' },
    { id: 't1', title: 'Itself', type: 'epic' },
  ];
  state.sprints = [
    { id: 's1', name: 'Sprint 1', status: 'active' },
    { id: 's2', name: 'Sprint 2', status: 'planned' },
    { id: 's0', name: 'Sprint 0', status: 'completed' },
  ];
});

describe('epicPageHref', () => {
  it('points at the epic page of the project', () => {
    expect(epicPageHref('p1', 'e1')).toBe('/weldflow/project/p1/epics/e1');
  });
});

describe('TaskAgileFields: when it shows', () => {
  it('renders nothing for a project that is not agile', () => {
    state.settings = { approach: 'tasklist' };
    const { container } = renderFields(task());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing where the edition has no agile delivery', () => {
    state.available = false;
    const { container } = renderFields(task());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a task without a project', () => {
    const { container } = renderFields(task({ projectId: null }));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows type, epic, sprint and points for a story in a scrum project', () => {
    renderFields(task({ storyPoints: 5, sprintId: 's1', epicId: 'e1' }));
    expect(screen.getByRole('button', { name: 'Item type: PBI' })).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('Sprint 1')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Story points of this item' })).toHaveValue(5);
    expect(screen.getByRole('link', { name: 'Open epic page' })).toHaveAttribute('href', '/weldflow/project/p1/epics/e1');
  });

  it('leaves out the sprint for a kanban project', () => {
    state.settings = { approach: 'kanban', itemTypes: { naming: 'pbi', featureLevel: false, enabled: ['story', 'task'] } };
    renderFields(task());
    expect(screen.queryByText('Set sprint')).toBeNull();
    expect(screen.getByText('Set epic')).toBeInTheDocument();
  });

  it('shows an epic as a container: no epic, sprint or points, with its note and a link to its page', () => {
    renderFields(task({ type: 'epic' }));
    expect(screen.queryByText('Set epic')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/Epics aren’t planned in sprints/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open epic page' })[0]).toHaveAttribute(
      'href',
      '/weldflow/project/p1/epics/t1',
    );
    expect(screen.queryByText('Acceptance criteria')).toBeNull();
  });

  it('shows a note for a spike and a feature but no epic page link', () => {
    renderFields(task({ type: 'spike' }));
    expect(screen.getByText(/Spikes are time-boxed/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open epic page' })).toBeNull();
  });

  it('shows a subtask as plain text, without the other fields', () => {
    renderFields(task({ type: 'task', parentTaskId: 'parent' }));
    expect(screen.getByText('Subtask')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Item type/ })).toBeNull();
    expect(screen.queryByText('Set epic')).toBeNull();
    expect(screen.queryByText('Acceptance criteria')).toBeNull();
  });
});

describe('TaskAgileFields: type', () => {
  it('changes the type from the menu, and cannot pick the current one', async () => {
    const user = userEvent.setup();
    renderFields(task());
    await user.click(screen.getByRole('button', { name: 'Item type: PBI' }));
    expect(await screen.findByRole('link', { name: /Settings › Item types/ })).toHaveAttribute(
      'href',
      '/weldflow/project/p1/settings#item-types',
    );
    expect(screen.queryByRole('menuitem', { name: /Subtask/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /PBI/ })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: /Bug/ }));
    expect(lastSave().taskId).toBe('t1');
    expect(lastSave().input).toEqual({ type: 'bug' });
  });

  it('takes an epic out of its sprint and its epic when the type becomes epic', async () => {
    const user = userEvent.setup();
    renderFields(task());
    await user.click(screen.getByRole('button', { name: 'Item type: PBI' }));
    await user.click(await screen.findByRole('menuitem', { name: /Epic/ }));
    expect(lastSave().input).toEqual({ type: 'epic', sprintId: null, epicId: null });
  });

  it('shows the API message of a refused change, else the generic one', async () => {
    const user = userEvent.setup();
    renderFields(task());
    await user.click(screen.getByRole('button', { name: 'Item type: PBI' }));
    await user.click(await screen.findByRole('menuitem', { name: /Bug/ }));
    const { onError } = state.mutate.mock.calls.at(-1)![1];
    onError(new ApiError('Not allowed', 403));
    expect(state.toastError).toHaveBeenLastCalledWith('Not allowed');
    onError(new Error('boom'));
    expect(state.toastError).toHaveBeenLastCalledWith('The type couldn’t be changed.');
  });
});

describe('TaskAgileFields: epic', () => {
  it('picks an epic and lists the other epics and features, not the task itself', async () => {
    const user = userEvent.setup();
    renderFields(task());
    await user.click(screen.getByRole('button', { name: 'Set epic' }));
    expect(await screen.findByRole('option', { name: 'Onboarding' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Itself' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Onboarding' }));
    expect(lastSave().input).toEqual({ epicId: 'e1' });
  });

  it('only offers epics to a feature', async () => {
    const user = userEvent.setup();
    state.settings = {
      approach: 'scrum',
      itemTypes: { naming: 'pbi', featureLevel: true, enabled: ['epic', 'feature', 'story', 'task'] },
    };
    renderFields(task({ type: 'feature' }));
    await user.click(screen.getByRole('button', { name: 'Set epic' }));
    expect(await screen.findByRole('option', { name: 'Onboarding' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Sign up' })).toBeNull();
  });

  it('clears the epic', async () => {
    const user = userEvent.setup();
    renderFields(task({ epicId: 'e1' }));
    await user.click(screen.getByRole('button', { name: 'Onboarding' }));
    await user.click(await screen.findByRole('option', { name: 'No epic' }));
    expect(lastSave().input).toEqual({ epicId: null });
  });

  it('marks the current epic and the failure message', async () => {
    const user = userEvent.setup();
    renderFields(task({ epicId: 'e1' }));
    await user.click(screen.getByRole('button', { name: 'Onboarding' }));
    await user.click(await screen.findByRole('option', { name: 'No epic' }));
    state.mutate.mock.calls.at(-1)![1].onError(new Error('x'));
    expect(state.toastError).toHaveBeenLastCalledWith('The epic couldn’t be changed.');
  });
});

describe('TaskAgileFields: sprint', () => {
  it('offers the planned and active sprints and plans the task in one', async () => {
    const user = userEvent.setup();
    renderFields(task());
    await user.click(screen.getByRole('button', { name: 'Set sprint' }));
    expect(await screen.findByRole('option', { name: /Sprint 1/ })).toHaveTextContent('Active');
    expect(screen.getByRole('option', { name: /Sprint 2/ })).toHaveTextContent('Planned');
    expect(screen.queryByRole('option', { name: /Sprint 0/ })).toBeNull();
    await user.click(screen.getByRole('option', { name: /Sprint 2/ }));
    expect(lastSave().input).toEqual({ sprintId: 's2' });
  });

  it('moves the task back to the backlog', async () => {
    const user = userEvent.setup();
    renderFields(task({ sprintId: 's1' }));
    await user.click(screen.getByRole('button', { name: 'Sprint 1' }));
    await user.click(await screen.findByRole('option', { name: /Backlog/ }));
    expect(lastSave().input).toEqual({ sprintId: null });
    state.mutate.mock.calls.at(-1)![1].onError(new Error('x'));
    expect(state.toastError).toHaveBeenLastCalledWith('The sprint couldn’t be changed.');
  });
});

describe('TaskAgileFields: story points', () => {
  const field = () => screen.getByRole('spinbutton', { name: 'Story points of this item' });

  it('saves new points when the field loses focus', async () => {
    const user = userEvent.setup();
    renderFields(task({ storyPoints: 3 }));
    await user.clear(field());
    await user.type(field(), '8');
    await user.tab();
    expect(lastSave().input).toEqual({ storyPoints: 8 });
  });

  it('commits on Enter and clears the estimate when emptied', async () => {
    const user = userEvent.setup();
    renderFields(task({ storyPoints: 3 }));
    await user.clear(field());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(lastSave().input).toEqual({ storyPoints: null }));
    state.mutate.mock.calls.at(-1)![1].onError(new Error('x'));
    expect(state.toastError).toHaveBeenLastCalledWith('The points couldn’t be saved.');
  });

  it('saves nothing when the value did not change', async () => {
    const user = userEvent.setup();
    renderFields(task({ storyPoints: 3 }));
    await user.click(field());
    await user.tab();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('puts the stored value back for a negative number', async () => {
    const user = userEvent.setup();
    renderFields(task({ storyPoints: 3 }));
    await user.clear(field());
    await user.type(field(), '-2');
    await user.tab();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(field()).toHaveValue(3);
  });

  it('puts the stored value back for a fraction: story points are whole numbers', async () => {
    const user = userEvent.setup();
    renderFields(task({ storyPoints: 3 }));
    await user.clear(field());
    await user.type(field(), '0.5');
    await user.tab();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(field()).toHaveValue(3);
    expect(field()).toHaveAttribute('step', '1');
  });

  it('starts empty without an estimate', () => {
    renderFields(task({ storyPoints: null }));
    expect(field()).toHaveValue(null);
    expect(field()).toHaveAttribute('placeholder', 'No estimate');
  });
});

describe('TaskAgileSections', () => {

  it('shows the acceptance criteria and the definition of done for a story', () => {
    renderFields(task({ acceptanceCriteria: 'Works offline' }));
    expect(screen.getByRole('heading', { name: 'Acceptance criteria' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('One criterion per line')).toHaveValue('Works offline');
    expect(screen.getByRole('region', { name: 'Definition of Done' })).toBeInTheDocument();
    expect(screen.getByText('Code reviewed')).toBeInTheDocument();
    expect(screen.getByText('Tests pass')).toBeInTheDocument();
  });

  it('says when no definition of done is set', () => {
    state.settings = { approach: 'scrum', definitionOfDone: [] };
    renderFields(task({ type: 'bug' }));
    expect(screen.getByText('No Definition of Done set for this project.')).toBeInTheDocument();
  });

  it('leaves the definition of done out for a task', () => {
    renderFields(task({ type: 'task' }));
    expect(screen.getByRole('heading', { name: 'Acceptance criteria' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Definition of Done' })).toBeNull();
  });

  it('saves trimmed criteria on blur, and null when emptied', async () => {
    const user = userEvent.setup();
    renderFields(task());
    const box = screen.getByPlaceholderText('One criterion per line');
    await user.type(box, '  Must log in  ');
    await user.tab();
    expect(lastSave().input).toEqual({ acceptanceCriteria: 'Must log in' });
    state.mutate.mock.calls.at(-1)![1].onError(new Error('x'));
    expect(state.toastError).toHaveBeenLastCalledWith('The criteria couldn’t be saved.');
  });

  it('clears the criteria and does not save an unchanged text', async () => {
    const user = userEvent.setup();
    renderFields(task({ acceptanceCriteria: 'Keep' }));
    const box = screen.getByPlaceholderText('One criterion per line');
    await user.click(box);
    await user.tab();
    expect(state.mutate).not.toHaveBeenCalled();
    await user.clear(box);
    await user.tab();
    expect(lastSave().input).toEqual({ acceptanceCriteria: null });
  });

  it('renders nothing for a subtask or where the project is not agile', () => {
    const { container } = renderFields(task({ parentTaskId: 'x' }));
    expect(screen.queryByRole('heading', { name: 'Acceptance criteria' })).toBeNull();
    container.remove();
    state.settings = { approach: 'tasklist' };
    renderFields(task());
    expect(screen.queryByRole('heading', { name: 'Acceptance criteria' })).toBeNull();
  });
});
