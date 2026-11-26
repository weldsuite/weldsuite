import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { ItemType } from '@weldsuite/app-api-client/schemas/flow-agile';
import { QuickCreateItem } from './quick-create-item';
import { TaskTypeBadge, useItemTypeLabel } from './task-type-badge';
import { renderHook } from '@testing-library/react';

const TYPES: ItemType[] = ['epic', 'story', 'bug', 'task'];

function setup(overrides: Partial<React.ComponentProps<typeof QuickCreateItem>> = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <I18nProvider initialLanguage="en">
      <QuickCreateItem
        types={TYPES}
        naming="pbi"
        featureLevel={false}
        placeholder="Add an item"
        onCreate={onCreate}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onCreate, input: screen.getByRole('textbox', { name: 'New item title' }) };
}

describe('QuickCreateItem', () => {
  afterEach(cleanup);

  it('adds the title as a PBI by default and clears the row', async () => {
    const { onCreate, input } = setup();
    await userEvent.type(input, '  Login page {Enter}');
    expect(onCreate).toHaveBeenCalledWith({ title: 'Login page', type: 'story' });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('does not add an empty title', async () => {
    const { onCreate, input } = setup();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await userEvent.type(input, '   {Enter}');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('reads a leading /bug as the type and says so', async () => {
    const { onCreate, input } = setup();
    await userEvent.type(input, '/bug Crash on save');
    expect(screen.getByText('Will be added as Bug')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onCreate).toHaveBeenCalledWith({ title: 'Crash on save', type: 'bug' });
  });

  it('ignores a prefix for a type the project does not offer', async () => {
    const { onCreate, input } = setup();
    await userEvent.type(input, '/spike Try it{Enter}');
    expect(onCreate).toHaveBeenCalledWith({ title: '/spike Try it', type: 'story' });
  });

  it('uses the type picked from the menu', async () => {
    const { onCreate, input } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Type of the new item: PBI' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Task/ }));
    expect(screen.getByRole('button', { name: 'Type of the new item: Task' })).toBeInTheDocument();
    await userEvent.type(input, 'Write docs{Enter}');
    expect(onCreate).toHaveBeenCalledWith({ title: 'Write docs', type: 'task' });
  });

  it('starts on the first offered type when the default is not offered', () => {
    setup({ types: ['bug', 'task'] });
    expect(screen.getByRole('button', { name: 'Type of the new item: Bug' })).toBeInTheDocument();
  });

  it('falls back to a task when no type is offered', () => {
    setup({ types: [] });
    expect(screen.getByRole('button', { name: 'Type of the new item: Task' })).toBeInTheDocument();
  });

  it('honours the given default type and the user-story naming', () => {
    setup({ defaultType: 'bug', naming: 'story', types: ['bug', 'story'] });
    expect(screen.getByRole('button', { name: 'Type of the new item: Bug' })).toBeInTheDocument();
  });

  it('keeps the text when creating fails, so it can be sent again', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('no'));
    const { input } = setup({ onCreate });
    await userEvent.type(input, 'Retry me{Enter}');
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(input).toHaveValue('Retry me');
  });
});

describe('TaskTypeBadge', () => {
  afterEach(cleanup);

  function badge(props: Partial<React.ComponentProps<typeof TaskTypeBadge>>) {
    render(
      <I18nProvider initialLanguage="en">
        <TaskTypeBadge type="bug" naming="pbi" {...props} />
      </I18nProvider>,
    );
  }

  it('shows the letter and name of the type', () => {
    badge({ type: 'bug' });
    expect(screen.getByRole('img', { name: 'Bug' })).toHaveTextContent('B');
  });

  it('names a story by the project naming', () => {
    badge({ type: 'story', naming: 'pbi' });
    expect(screen.getByRole('img', { name: 'PBI' })).toHaveTextContent('P');
    cleanup();
    badge({ type: 'story', naming: 'story' });
    expect(screen.getByRole('img', { name: 'User story' })).toHaveTextContent('U');
  });

  it('reads a task with a parent as a subtask, and an unknown type as a task', () => {
    badge({ type: 'story', hasParent: true });
    expect(screen.getByRole('img', { name: 'Subtask' })).toBeInTheDocument();
    cleanup();
    badge({ type: 'whatever' });
    expect(screen.getByRole('img', { name: 'Task' })).toBeInTheDocument();
  });

  it('reads a feature as a story without the feature level', () => {
    badge({ type: 'feature', featureLevel: false });
    expect(screen.getByRole('img', { name: 'PBI' })).toBeInTheDocument();
    cleanup();
    badge({ type: 'feature', featureLevel: true, size: 'sm', className: 'mt-1' });
    expect(screen.getByRole('img', { name: 'Feature' }).className).toContain('mt-1');
  });
});

describe('useItemTypeLabel', () => {
  it('returns the label of each type', () => {
    const { result } = renderHook(() => useItemTypeLabel(), {
      wrapper: ({ children }) => <I18nProvider initialLanguage="en">{children}</I18nProvider>,
    });
    expect(result.current('epic', 'pbi')).toBe('Epic');
    expect(result.current('story', 'story')).toBe('User story');
  });
});
