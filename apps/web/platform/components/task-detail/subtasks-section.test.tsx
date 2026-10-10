import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Heavy siblings of SubtasksSection in task-detail-content.tsx; none of them
// take part in the subtask flow, so stub them out.
vi.mock('@/hooks/queries/use-github-queries', () => ({ useLinkedRepos: () => ({ data: [] }) }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({ useWorkspaceMembers: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({}) }));
vi.mock('@/hooks/use-drawer-field-visibility', () => ({ useDrawerFieldVisibility: () => ({}) }));
vi.mock('@/components/entity-audit-panel', () => ({ EntityAuditPanel: () => null }));
vi.mock('@/app/weldchat/components/emoji-picker', () => ({ EmojiPicker: () => null }));
vi.mock('@/app/weldchat/components/mention-autocomplete', () => ({ MentionAutocomplete: () => null }));
vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

import { SubtasksSection } from './task-detail-content';

const ADD_LABEL = 'sweep.shared.addSubtask';
const PLACEHOLDER = 'sweep.shared.subtaskTitlePlaceholder';

function renderSection(subtasks: Array<{ id: string; title: string; status: string; assignee: null }> = []) {
  const onCreateSubtask = vi.fn();
  render(
    <SubtasksSection
      subtasks={subtasks}
      currentTaskId="task_parent"
      rootTask={{ id: 'task_parent', title: 'Parent', status: 'todo' }}
      onCreateSubtask={onCreateSubtask}
    />,
  );
  return { onCreateSubtask };
}

describe('SubtasksSection inline add', () => {
  it('shows a focused title input and creates nothing when "Add subtask" is clicked', () => {
    const { onCreateSubtask } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: ADD_LABEL }));

    const input = screen.getByPlaceholderText(PLACEHOLDER);
    expect(input).toHaveFocus();
    expect(onCreateSubtask).not.toHaveBeenCalled();
  });

  it('creates the subtask with the typed (trimmed) title on Enter and keeps the input open for the next one', () => {
    const { onCreateSubtask } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: ADD_LABEL }));

    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: '  Sub A  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCreateSubtask).toHaveBeenCalledTimes(1);
    expect(onCreateSubtask).toHaveBeenLastCalledWith('Sub A');

    // Still there, emptied and focused: the next title can be typed right away.
    const again = screen.getByPlaceholderText(PLACEHOLDER);
    expect(again).toHaveValue('');
    expect(again).toHaveFocus();

    fireEvent.change(again, { target: { value: 'Sub B' } });
    fireEvent.keyDown(again, { key: 'Enter' });

    expect(onCreateSubtask).toHaveBeenCalledTimes(2);
    expect(onCreateSubtask).toHaveBeenLastCalledWith('Sub B');
  });

  it('does not create anything on Enter with a blank title', () => {
    const { onCreateSubtask } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: ADD_LABEL }));

    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCreateSubtask).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('cancels on Escape without creating anything', () => {
    const { onCreateSubtask } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: ADD_LABEL }));

    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'Mobile version' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCreateSubtask).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: ADD_LABEL })).toBeInTheDocument();
  });

  it('opens the same inline input from the header "+" when subtasks already exist', () => {
    const { onCreateSubtask } = renderSection([
      { id: 'task_child', title: 'Existing subtask', status: 'todo', assignee: null },
    ]);

    // With subtasks present the only add control is the icon button in the header.
    const buttons = screen.getAllByRole('button');
    const plus = buttons.find((b) => b.className.includes('group-hover/subtasks-section:opacity-100'));
    expect(plus).toBeDefined();
    fireEvent.click(plus as HTMLElement);

    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveFocus();
    expect(onCreateSubtask).not.toHaveBeenCalled();
  });
});

describe('SubtasksSection rows', () => {
  it('does not list the open task itself as a subtask', () => {
    renderSection([{ id: 'task_child', title: 'Existing subtask', status: 'todo', assignee: null }]);

    expect(screen.getByText('Existing subtask')).toBeInTheDocument();
    expect(screen.queryByText('Parent')).not.toBeInTheDocument();
  });

  it('shows the real parent above the open task when the task is itself a subtask', () => {
    render(
      <SubtasksSection
        subtasks={[]}
        parentTask={{ id: 'task_root', title: 'Grandparent', status: 'todo' }}
        currentTaskId="task_parent"
        rootTask={{ id: 'task_parent', title: 'Parent', status: 'todo' }}
        onCreateSubtask={vi.fn()}
      />,
    );

    expect(screen.getByText('Grandparent')).toBeInTheDocument();
    expect(screen.getByText('Parent')).toBeInTheDocument();
  });
});
