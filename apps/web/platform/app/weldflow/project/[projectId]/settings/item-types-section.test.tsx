import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';

const state = vi.hoisted(() => ({
  loading: false,
  saving: false,
  settings: {} as Record<string, unknown>,
  save: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError, success: state.toastSuccess } }));
vi.mock('@/hooks/queries/use-flow-agile-queries', async () => {
  const { deliveryModel } = await import('@/app/weldflow/lib/delivery');
  return {
    useProjectDelivery: () => ({ ...deliveryModel({ delivery: state.settings }, true), isLoading: state.loading }),
    useUpdateProjectDelivery: () => ({ mutate: state.save, isPending: state.saving }),
  };
});

import { ItemTypesSection } from './item-types-section';

function renderSection(isAdmin = true) {
  return render(
    <I18nProvider initialLanguage="en">
      <ItemTypesSection projectId="p1" isAdmin={isAdmin} />
    </I18nProvider>,
  );
}

const saveButton = () => screen.getByRole('button', { name: 'Save' });
const saved = () => state.save.mock.calls.at(-1)![0];

beforeEach(() => {
  vi.clearAllMocks();
  state.loading = false;
  state.saving = false;
  state.settings = {
    approach: 'scrum',
    itemTypes: { naming: 'pbi', featureLevel: false, enabled: ['epic', 'story', 'bug', 'task', 'spike', 'subtask'] },
  };
});

describe('ItemTypesSection', () => {
  it('shows a loader while the project loads', () => {
    state.loading = true;
    renderSection();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('lists the types, with the feature type only when the feature level is on', () => {
    renderSection();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Epic' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Spike' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Feature' })).toBeNull();
    // Story and task cannot be turned off.
    expect(screen.getAllByText('Always on')).toHaveLength(2);
    expect(saveButton()).toBeDisabled();
  });

  it('explains that item types belong to the agile approaches for a task list', () => {
    state.settings = { approach: 'tasklist' };
    renderSection();
    expect(screen.getByText(/Item types are part of the Scrum, Kanban and Hybrid/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Epic' })).toBeDisabled();
  });

  it('tells a non-manager they cannot change it', () => {
    renderSection(false);
    expect(screen.getByText('Only project managers can change the delivery approach.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Bug' })).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  it('turns a type off and saves the whole delivery setting with it', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('checkbox', { name: 'Spike' }));
    expect(screen.getByRole('checkbox', { name: 'Spike' })).not.toBeChecked();
    await user.click(saveButton());
    expect(saved().approach).toBe('scrum');
    expect(saved().itemTypes.enabled).toEqual(['epic', 'story', 'bug', 'task', 'subtask']);
  });

  it('turns a type on in the canonical order', async () => {
    const user = userEvent.setup();
    state.settings = {
      approach: 'scrum',
      itemTypes: { naming: 'pbi', featureLevel: false, enabled: ['story', 'task'] },
    };
    renderSection();
    await user.click(screen.getByRole('checkbox', { name: 'Bug' }));
    await user.click(screen.getByRole('checkbox', { name: 'Epic' }));
    await user.click(saveButton());
    expect(saved().itemTypes.enabled).toEqual(['epic', 'story', 'bug', 'task']);
  });

  it('renames a story and shows it in the table', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getAllByRole('img', { name: 'PBI' }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('radio', { name: 'User story' }));
    expect(screen.getAllByRole('img', { name: 'User story' }).length).toBeGreaterThan(0);
    await user.click(saveButton());
    expect(saved().itemTypes.naming).toBe('story');
  });

  it('adds the feature type with the feature level, and takes it away again', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('checkbox', { name: 'Feature' })).toBeChecked();
    await user.click(saveButton());
    expect(saved().itemTypes).toMatchObject({ featureLevel: true });
    expect(saved().itemTypes.enabled).toContain('feature');

    await user.click(screen.getByRole('switch'));
    await user.click(saveButton());
    expect(saved().itemTypes.featureLevel).toBe(false);
    expect(saved().itemTypes.enabled).not.toContain('feature');
  });

  it('says saved on success, discards the draft on cancel', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('checkbox', { name: 'Spike' }));
    await user.click(saveButton());
    state.save.mock.calls[0]![1].onSuccess();
    expect(state.toastSuccess).toHaveBeenCalledWith('Saved');
    await user.click(await screen.findByRole('checkbox', { name: 'Spike' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('checkbox', { name: 'Spike' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows the API message of a refusal, else the generic one', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('checkbox', { name: 'Spike' }));
    await user.click(saveButton());
    const { onError } = state.save.mock.calls[0]![1];
    onError(new ApiError('Not allowed', 403));
    expect(state.toastError).toHaveBeenLastCalledWith('Not allowed');
    onError(new Error('boom'));
    expect(state.toastError).toHaveBeenLastCalledWith('This couldn’t be saved. Try again.');
  });

  it('does not save without a change and shows "Saving…" during a save', () => {
    state.saving = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });
});
