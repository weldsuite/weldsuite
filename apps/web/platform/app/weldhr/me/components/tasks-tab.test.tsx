import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfTask } from '@weldsuite/app-api-client/domains/weldhr';

const t = en.weldhr.me.tasks;

const mocks = vi.hoisted(() => ({ complete: vi.fn(), toastError: vi.fn() }));

let state: { data: HrSelfTask[] | undefined; isLoading: boolean; error: Error | null };
let completion: { isPending: boolean; variables: { id: string; done: boolean } | undefined };

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrTasks: () => state,
  useMyHrCompleteTask: () => ({ mutateAsync: mocks.complete, ...completion }),
}));

import { MyTasksTab } from './tasks-tab';

function task(extra: Partial<HrSelfTask> = {}): HrSelfTask {
  return {
    id: 'task_1',
    title: 'Sign the contract',
    description: null,
    dueDate: '2026-12-01',
    assigneeRole: 'employee',
    completedAt: null,
    canComplete: true,
    checklistName: 'Welcome checklist',
    checklistKind: 'onboarding',
    ...extra,
  };
}

const tasks: HrSelfTask[] = [
  task(),
  task({ id: 'task_2', title: 'Return the laptop', description: 'Hand it to IT', dueDate: '2026-11-01', checklistName: 'Leaving', checklistKind: 'offboarding' }),
  task({ id: 'task_3', title: 'Set up email', dueDate: null, assigneeRole: 'manager', canComplete: false, completedAt: '2026-11-10T10:00:00.000Z' }),
  task({ id: 'task_4', title: 'Collect the badge', assigneeRole: 'hr' as HrSelfTask['assigneeRole'] }),
];

function renderTab() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyTasksTab />
    </I18nProvider>,
  );
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest('div.group');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  mocks.complete.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  state = { data: tasks, isLoading: false, error: null };
  completion = { isPending: false, variables: undefined };
});

afterEach(() => vi.useRealTimers());

describe('MyTasksTab', () => {
  it('groups the tasks per checklist with the number done on the header', () => {
    renderTab();
    expect(screen.getAllByText('Leaving').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Welcome checklist').length).toBeGreaterThan(0);
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    expect(screen.getByText('0 of 1 done')).toBeInTheDocument();
  });

  it('shows each task with its state, kind, due date and assignee', () => {
    renderTab();
    const open = rowOf('Sign the contract');
    expect(within(open).getByText(t.states.open)).toBeInTheDocument();
    expect(within(open).getByText(en.weldhr.status.checklistKind.onboarding)).toBeInTheDocument();
    expect(within(open).getByText(t.you)).toBeInTheDocument();

    const overdue = rowOf('Return the laptop');
    expect(within(overdue).getByText(t.overdue)).toBeInTheDocument();
    expect(within(overdue).getByText(en.weldhr.status.checklistKind.offboarding)).toBeInTheDocument();
    expect(overdue.querySelector('[title="Hand it to IT"]')).not.toBeNull();

    const done = rowOf('Set up email');
    expect(within(done).getByText(t.states.done)).toBeInTheDocument();
    expect(within(done).getByText('—')).toBeInTheDocument();
    expect(within(done).getByText(en.weldhr.status.assigneeRole.manager)).toBeInTheDocument();
    expect(done.className).toContain('opacity-50');

    expect(within(rowOf('Collect the badge')).getByText(en.weldhr.status.assigneeRole.hr)).toBeInTheDocument();
  });

  it('lets the employee tick and untick a task they can complete', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(rowOf('Sign the contract')).getByRole('checkbox', { name: 'Sign the contract' }));
    expect(mocks.complete).toHaveBeenCalledWith({ id: 'task_1', done: true });
  });

  it('unticks a task that is done and the employee may complete', async () => {
    const user = userEvent.setup();
    state = { data: [task({ id: 'task_9', title: 'Done already', completedAt: '2026-11-10T10:00:00.000Z' })], isLoading: false, error: null };
    renderTab();
    await user.click(screen.getByRole('checkbox', { name: 'Done already' }));
    expect(mocks.complete).toHaveBeenCalledWith({ id: 'task_9', done: false });
  });

  it('disables the checkbox of a task someone else completes, and of the one being saved', () => {
    completion = { isPending: true, variables: { id: 'task_1', done: true } };
    renderTab();
    expect(screen.getByRole('checkbox', { name: 'Set up email' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Sign the contract' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Collect the badge' })).toBeEnabled();
  });

  it('toasts the error when a task could not be saved', async () => {
    mocks.complete.mockRejectedValueOnce(new Error('Checklist is closed'));
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('checkbox', { name: 'Collect the badge' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Checklist is closed'));
  });

  it('toasts the generic message when the error has none', async () => {
    mocks.complete.mockRejectedValueOnce('nope');
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('checkbox', { name: 'Collect the badge' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t.failed));
  });

  it('searches the title, description and checklist name', async () => {
    const user = userEvent.setup();
    renderTab();
    const search = screen.getAllByPlaceholderText(t.searchPlaceholder)[0];
    await user.type(search, 'hand it');
    expect(screen.getByText('Return the laptop')).toBeInTheDocument();
    expect(screen.queryByText('Sign the contract')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'welcome');
    expect(screen.getByText('Sign the contract')).toBeInTheDocument();
    expect(screen.queryByText('Return the laptop')).not.toBeInTheDocument();
  });

  async function pickFilter(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
    await user.click(screen.getByRole('button', { name: /filter/i }));
    const fields = await screen.findAllByText(field);
    await user.click(fields[fields.length - 1]);
    const options = await screen.findAllByText(option);
    await user.click(options[options.length - 1]);
  }

  it('narrows to overdue tasks with the status filter', async () => {
    const user = userEvent.setup();
    renderTab();
    await pickFilter(user, t.columns.status, t.overdue);
    expect(screen.getByText('Return the laptop')).toBeInTheDocument();
    expect(screen.queryByText('Sign the contract')).not.toBeInTheDocument();
    expect(screen.queryByText('Set up email')).not.toBeInTheDocument();
  });

  it('narrows to offboarding tasks with the type filter', async () => {
    const user = userEvent.setup();
    renderTab();
    await pickFilter(user, t.columns.type, en.weldhr.status.checklistKind.offboarding);
    expect(screen.getByText('Return the laptop')).toBeInTheDocument();
    expect(screen.queryByText('Sign the contract')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no tasks', () => {
    state = { data: [], isLoading: false, error: null };
    renderTab();
    expect(screen.getByText(t.empty)).toBeInTheDocument();
  });

  it('shows a loader while loading', () => {
    state = { data: undefined, isLoading: true, error: null };
    renderTab();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows the error when the tasks could not be loaded', () => {
    state = { data: undefined, isLoading: false, error: new Error('Server unavailable') };
    renderTab();
    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
  });

  it('keeps the tasks on screen when a refetch failed but data is there', () => {
    state = { data: tasks, isLoading: false, error: new Error('Refetch failed') };
    renderTab();
    expect(screen.getByText('Sign the contract')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load data')).not.toBeInTheDocument();
  });
});
