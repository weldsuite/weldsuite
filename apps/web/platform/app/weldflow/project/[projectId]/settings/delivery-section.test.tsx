import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';

const state = vi.hoisted(() => ({
  loading: false,
  settings: {} as Record<string, unknown>,
  stages: { success: true, data: [] } as { success: boolean; data?: unknown[] },
  save: vi.fn(),
  saving: false,
  saveTabs: vi.fn(),
  tabSettings: { hidden: ['table'], roles: { member: [], viewer: [] }, members: [] },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError, success: state.toastSuccess } }));
vi.mock('@/app/weldflow/lib/api-client', () => ({
  stagesApi: { list: vi.fn(async () => state.stages) },
}));
vi.mock('@/app/weldflow/hooks/use-project-tabs', () => ({
  useProjectTabDefs: () => ['tasks', 'pipeline', 'gantt', 'table', 'settings'].map((id) => ({ id })),
}));
vi.mock('@/hooks/queries/use-project-tab-settings', () => ({
  useProjectTabSettings: () => ({ settings: state.tabSettings, isLoading: false }),
  useUpdateProjectTabSettings: () => ({ mutate: state.saveTabs }),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', async () => {
  const { deliveryModel } = await import('@/app/weldflow/lib/delivery');
  return {
    agileKeys: { root: (id: string) => ['projects', id, 'agile'] },
    useProjectDelivery: () => ({ ...deliveryModel({ delivery: state.settings }, true), isLoading: state.loading }),
    useUpdateProjectDelivery: () => ({ mutate: state.save, isPending: state.saving }),
  };
});

import { DeliverySection } from './delivery-section';

function renderSection(isAdmin = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">{children}</I18nProvider>
    </QueryClientProvider>
  );
  return render(<DeliverySection projectId="p1" isAdmin={isAdmin} />, { wrapper });
}

const STAGES = [
  { id: 'todo', name: 'To do', color: '#ccc' },
  { id: 'doing', name: 'Doing', color: null },
];

const radio = (name: RegExp | string) => screen.getByRole('radio', { name });
const saveButton = () => screen.getByRole('button', { name: 'Save' });

/** What the last save was asked to write. */
const saved = () => state.save.mock.calls.at(-1)![0];

beforeEach(() => {
  // jsdom has no pointer capture, which Radix Select needs.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  vi.clearAllMocks();
  state.loading = false;
  state.saving = false;
  state.settings = { approach: 'scrum', sprintLengthDays: 14, definitionOfDone: ['Reviewed'] };
  state.stages = { success: true, data: STAGES };
  state.tabSettings = { hidden: ['table'], roles: { member: [], viewer: [] }, members: [] };
});

describe('DeliverySection', () => {
  it('shows a loader while the project loads', () => {
    state.loading = true;
    renderSection();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('lists the approaches with the current one picked and what it changes', () => {
    renderSection();
    expect(radio(/Scrum/)).toBeChecked();
    expect(screen.getByText('Tasks opens on the backlog')).toBeInTheDocument();
    expect(screen.getByText('The Pipeline shows the active sprint')).toBeInTheDocument();
    expect(screen.getByText('Sprints with planning, reports and retros')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('tells a non-manager they cannot change it and disables everything', () => {
    renderSection(false);
    expect(screen.getByText('Only project managers can change the delivery approach.')).toBeInTheDocument();
    expect(radio(/Kanban/)).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  it('describes each approach in the "what changes" list', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(radio(/Task list/));
    expect(screen.getByText('Nothing changes: this is how WeldFlow works today.')).toBeInTheDocument();
    await user.click(radio(/Predictive/));
    expect(screen.getByText('Tasks opens on the list')).toBeInTheDocument();
    expect(screen.getByText('The Pipeline shows all open work')).toBeInTheDocument();
    expect(screen.getByText('No item types')).toBeInTheDocument();
    expect(screen.getByText('Gantt › Phases plans the phases and gates')).toBeInTheDocument();
    await user.click(radio(/Kanban/));
    expect(screen.getByText('The Pipeline shows WIP limits per column')).toBeInTheDocument();
    await user.click(radio(/Hybrid/));
    expect(screen.getByText('Gantt › Phases shows the sprints inside each phase')).toBeInTheDocument();
  });

  it('shows the sprint length only for an approach with sprints', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getByText('Sprint length')).toBeInTheDocument();
    await user.click(radio(/Kanban/));
    expect(screen.queryByText('Sprint length')).toBeNull();
  });

  it('shows a sprint length that is not a whole number of weeks', () => {
    state.settings = { approach: 'scrum', sprintLengthDays: 10 };
    renderSection();
    expect(screen.getByRole('combobox')).toHaveTextContent('10 days');
  });

  it('changes the sprint length from the list', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getByRole('combobox')).toHaveTextContent('2 weeks');
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: '1 week' }));
    await user.click(saveButton());
    expect(saved().sprintLengthDays).toBe(7);
  });

  it('saves a changed approach, then clears the draft and says so', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(radio(/Kanban/));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.click(saveButton());
    expect(saved()).toMatchObject({ approach: 'kanban', definitionOfDone: ['Reviewed'] });

    state.save.mock.calls[0]![1].onSuccess();
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith('Saved'));
    await waitFor(() => expect(radio(/Scrum/)).toBeChecked());
  });

  it('shows the API message when the save is refused, else the generic one', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(radio(/Kanban/));
    await user.click(saveButton());
    const { onError } = state.save.mock.calls[0]![1];
    onError(new ApiError('Managers only', 403));
    expect(state.toastError).toHaveBeenLastCalledWith('Managers only');
    onError(new Error('boom'));
    expect(state.toastError).toHaveBeenLastCalledWith('This couldn’t be saved. Try again.');
  });

  it('discards the draft on cancel', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(radio(/Kanban/));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(radio(/Scrum/)).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows "Saving…" and refuses a second submit while a save runs', () => {
    state.saving = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('does not save when nothing changed, even on Enter', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByPlaceholderText('Add a criterion'), '{Enter}');
    expect(state.save).not.toHaveBeenCalled();
  });
});

describe('DeliverySection: suggested tabs', () => {
  it('offers the suggested tabs once the approach changes, and hides the others after the save', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.queryByRole('checkbox', { name: /Also show the tabs/ })).toBeNull();
    await user.click(radio(/Kanban/));
    const box = screen.getByRole('checkbox', { name: /Also show the tabs/ });
    expect(box).toBeChecked();
    await user.click(saveButton());
    state.save.mock.calls[0]![1].onSuccess();
    // Kanban suggests tasks and pipeline (plus settings): gantt and table are hidden.
    expect(state.saveTabs).toHaveBeenCalledTimes(1);
    expect(state.saveTabs.mock.calls[0]![0]).toMatchObject({ hidden: ['gantt', 'table'] });
    state.saveTabs.mock.calls[0]![1].onError(new Error('x'));
    expect(state.toastError).toHaveBeenLastCalledWith('This couldn’t be saved. Try again.');
  });

  it('leaves the tabs alone when the box is unchecked', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(radio(/Kanban/));
    await user.click(screen.getByRole('checkbox', { name: /Also show the tabs/ }));
    await user.click(saveButton());
    state.save.mock.calls[0]![1].onSuccess();
    expect(state.saveTabs).not.toHaveBeenCalled();
  });

  it('does not offer tabs for the task list, which suggests none', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(radio(/Task list/));
    expect(screen.queryByRole('checkbox', { name: /Also show the tabs/ })).toBeNull();
  });
});

describe('DeliverySection: WIP limits', () => {
  it('lists the pipeline stages with their limits', async () => {
    state.settings = { approach: 'kanban', wipLimits: { todo: 3 } };
    renderSection();
    const todo = await screen.findByRole('spinbutton', { name: 'To do' });
    expect(todo).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Doing' })).toHaveValue(null);
  });

  it('sets, caps and removes a limit', async () => {
    const user = userEvent.setup();
    state.settings = { approach: 'kanban', wipLimits: { todo: 3 } };
    renderSection();
    const doing = await screen.findByRole('spinbutton', { name: 'Doing' });
    await user.type(doing, '5');
    await user.click(saveButton());
    expect(saved().wipLimits).toEqual({ todo: 3, doing: 5 });
    await user.clear(screen.getByRole('spinbutton', { name: 'To do' }));
    await user.click(saveButton());
    expect(saved().wipLimits).toEqual({ doing: 5 });
    await user.type(screen.getByRole('spinbutton', { name: 'To do' }), '5000');
    await user.click(saveButton());
    expect(saved().wipLimits.todo).toBe(999);
  });

  it('says when there are no stages, and hides limits for approaches without a board', async () => {
    const user = userEvent.setup();
    state.settings = { approach: 'kanban' };
    state.stages = { success: false };
    renderSection();
    expect(await screen.findByText('This project has no pipeline stages yet.')).toBeInTheDocument();
    await user.click(radio(/Predictive/));
    expect(screen.queryByText('WIP limits')).toBeNull();
  });
});

describe('DeliverySection: definition of done', () => {
  it('lists the criteria and removes one', async () => {
    const user = userEvent.setup();
    state.settings = { approach: 'scrum', definitionOfDone: ['Reviewed', 'Tested'] };
    renderSection();
    expect(screen.getByText('Tested')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove “Reviewed”' }));
    expect(screen.queryByText('Reviewed')).toBeNull();
    await user.click(saveButton());
    expect(saved().definitionOfDone).toEqual(['Tested']);
  });

  it('adds a criterion with the button or Enter, trimmed, and ignores an empty one', async () => {
    const user = userEvent.setup();
    state.settings = { approach: 'scrum', definitionOfDone: [] };
    renderSection();
    expect(screen.getByText('No criteria yet.')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    const input = screen.getByPlaceholderText('Add a criterion');
    await user.type(input, '  Documented  ');
    await user.click(add);
    expect(input).toHaveValue('');
    await user.type(input, 'Deployed{Enter}');
    await user.type(input, '   {Enter}');
    await user.click(saveButton());
    expect(saved().definitionOfDone).toEqual(['Documented', 'Deployed']);
  });

  it('stops offering the field at the maximum number of criteria', () => {
    state.settings = { approach: 'scrum', definitionOfDone: Array.from({ length: 20 }, (_, i) => `Criterion ${i}`) };
    renderSection();
    expect(screen.queryByPlaceholderText('Add a criterion')).toBeNull();
  });

  it('is not shown for an approach without item types', () => {
    state.settings = { approach: 'predictive' };
    renderSection();
    expect(screen.queryByText('Definition of Done')).toBeNull();
  });

  it('keeps the whole form disabled for a non-manager', () => {
    renderSection(false);
    expect(screen.getByPlaceholderText('Add a criterion')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove/ })).toBeDisabled();
  });
});
