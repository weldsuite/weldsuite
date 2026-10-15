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
  it('shows an open main task once, as the root its subtasks hang from', () => {
    renderSection([{ id: 'task_child', title: 'Existing subtask', status: 'todo', assignee: null }]);

    const root = screen.getByText('Parent');
    const child = screen.getByText('Existing subtask');
    expect(screen.getAllByText('Parent')).toHaveLength(1);
    expect(root.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('shows the whole chain from the main task down to the open task and its subtree', () => {
    render(
      <SubtasksSection
        subtasks={[
          { id: 'task_child', title: 'Child', status: 'todo', assignee: null, depth: 0 },
          { id: 'task_grandchild', title: 'Grandchild', status: 'todo', assignee: null, depth: 1 },
        ]}
        ancestorTasks={[
          { id: 'task_main', title: 'Main task', status: 'todo' },
          { id: 'task_sub', title: 'Subtask', status: 'todo' },
        ]}
        currentTaskId="task_open"
        rootTask={{ id: 'task_open', title: 'Open task', status: 'todo' }}
        onCreateSubtask={vi.fn()}
      />,
    );

    const order = ['Main task', 'Subtask', 'Open task', 'Child', 'Grandchild'].map(
      (title) => screen.getByText(title),
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The count covers the open task's direct children only.
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });
});

describe('SubtasksSection open/closed', () => {
  const HEADER = 'sweep.shared.subtasks';

  it('starts closed when the task has no subtasks and no parent', () => {
    renderSection();
    // Only the header's quick-add is there; the inline "Add subtask" row isn't.
    const adds = screen.getAllByRole('button', { name: ADD_LABEL });
    expect(adds).toHaveLength(1);
    expect(adds[0].className).toContain('group-hover/subtasks-section:opacity-100');
  });

  it('starts open when the task has subtasks', () => {
    renderSection([{ id: 'task_child', title: 'Existing subtask', status: 'todo', assignee: null }]);
    expect(screen.getByText('Existing subtask')).toBeInTheDocument();
  });

  it('starts open for a subtask so its parent chain shows', () => {
    render(
      <SubtasksSection
        subtasks={[]}
        ancestorTasks={[{ id: 'task_main', title: 'Main task', status: 'todo' }]}
        currentTaskId="task_open"
        rootTask={{ id: 'task_open', title: 'Open task', status: 'todo' }}
        onCreateSubtask={vi.fn()}
      />,
    );
    expect(screen.getByText('Main task')).toBeInTheDocument();
  });

  it('opens on a header click even when empty', () => {
    renderSection();
    fireEvent.click(screen.getByText(HEADER));
    // The inline "Add subtask" row shows once open; the header quick-add hides.
    const adds = screen.getAllByRole('button', { name: ADD_LABEL });
    expect(adds).toHaveLength(1);
    expect(adds[0].className).not.toContain('group-hover/subtasks-section:opacity-100');
  });
});
