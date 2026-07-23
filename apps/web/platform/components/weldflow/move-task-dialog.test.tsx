import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// --- Mocks ----------------------------------------------------------------
// The dialog pulls projects + the move mutation from hooks and strings from
// i18n. Mock all three (plus the toast) so we test the dialog's behaviour in
// isolation, not the data layer.

const mutateAsync = vi.fn();
let projectsResult: { data?: { data: { id: string; name?: string }[] }; isLoading: boolean };

vi.mock('@/hooks/queries/use-projects-queries', () => ({
  useProjects: () => projectsResult,
}));

vi.mock('@/hooks/queries/use-task-queries', () => ({
  useMoveTask: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel' },
      projects: {
        tasks: {
          moveTaskDialogTitle: 'Move task to project',
          moveTaskDialogDescription: 'Pick a destination project.',
          moveTaskSearchPlaceholder: 'Search projects...',
          moveTaskNoProjects: 'No projects found',
          moveTaskConfirm: 'Move task',
          moveTaskInProgress: 'Moving…',
          taskMoved: 'Task moved',
          taskMovedWithSubtasks: '{count} subtasks moved along with it',
          failedToMoveTask: 'Failed to move task',
        },
      },
    },
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }));

import { MoveTaskDialog } from './move-task-dialog';

beforeEach(() => {
  vi.clearAllMocks();
  projectsResult = {
    isLoading: false,
    data: {
      data: [
        { id: 'p1', name: 'Alpha' },
        { id: 'cur', name: 'Current' },
        { id: 'p2', name: 'Beta' },
      ],
    },
  };
});

describe('MoveTaskDialog', () => {
  it('lists destination projects but excludes the current one', () => {
    render(
      <MoveTaskDialog open onOpenChange={() => {}} taskId="t1" currentProjectId="cur" />,
    );

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // The task's own project must not be a move target.
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no other projects', () => {
    projectsResult = { isLoading: false, data: { data: [{ id: 'cur', name: 'Current' }] } };
    render(
      <MoveTaskDialog open onOpenChange={() => {}} taskId="t1" currentProjectId="cur" />,
    );
    expect(screen.getByText('No projects found')).toBeInTheDocument();
  });

  it('disables the confirm button until a project is selected', () => {
    render(<MoveTaskDialog open onOpenChange={() => {}} taskId="t1" currentProjectId="cur" />);
    expect(screen.getByRole('button', { name: 'Move task' })).toBeDisabled();
  });

  it('moves the task to the selected project and reports success', async () => {
    mutateAsync.mockResolvedValue({ id: 't1', projectId: 'p1', movedSubtaskCount: 0 });
    const onOpenChange = vi.fn();
    const onMoved = vi.fn();
    const user = userEvent.setup();

    render(
      <MoveTaskDialog
        open
        onOpenChange={onOpenChange}
        taskId="t1"
        currentProjectId="cur"
        onMoved={onMoved}
      />,
    );

    await user.click(screen.getByText('Alpha'));
    await user.click(screen.getByRole('button', { name: 'Move task' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ id: 't1', projectId: 'p1' }));
    expect(toastSuccess).toHaveBeenCalledWith('Task moved');
    expect(onMoved).toHaveBeenCalledWith({ id: 't1', projectId: 'p1', movedSubtaskCount: 0 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('includes the subtask count in the success toast when subtasks moved', async () => {
    mutateAsync.mockResolvedValue({ id: 't1', projectId: 'p2', movedSubtaskCount: 3 });
    const user = userEvent.setup();

    render(<MoveTaskDialog open onOpenChange={() => {}} taskId="t1" currentProjectId="cur" />);

    await user.click(screen.getByText('Beta'));
    await user.click(screen.getByRole('button', { name: 'Move task' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Task moved · 3 subtasks moved along with it'),
    );
  });

  it('surfaces an error toast when the move fails', async () => {
    mutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();

    render(<MoveTaskDialog open onOpenChange={() => {}} taskId="t1" currentProjectId="cur" />);

    await user.click(screen.getByText('Alpha'));
    await user.click(screen.getByRole('button', { name: 'Move task' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to move task'));
  });
});
