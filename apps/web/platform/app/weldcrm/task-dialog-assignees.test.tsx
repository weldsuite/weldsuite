import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { TaskDialog } from './task-dialog';

vi.mock('@/hooks/use-file-upload', () => ({
  useFileUpload: () => ({
    uploadFile: vi.fn(),
    isUploading: false,
    progress: 0,
    currentFileName: '',
  }),
}));

vi.mock('@/hooks/queries/use-github-queries', () => ({
  useLinkedRepos: () => ({ data: { data: [] } }),
}));

const members = [
  { id: 'user_ada', name: 'Ada Lovelace' },
  { id: 'user_grace', name: 'Grace Hopper' },
];

function renderDialog(
  availableAssignees: typeof members,
  onSave = vi.fn(),
) {
  render(
    <I18nProvider initialLanguage="en">
      <TaskDialog
        open
        onOpenChange={() => {}}
        editingTask={null}
        availableAssignees={availableAssignees}
        availableCompanies={[]}
        hideRecord
        defaultAssignee="user_ada"
        onSave={onSave}
        onUpdate={() => {}}
        isPending={false}
      />
    </I18nProvider>,
  );
  return onSave;
}

describe('TaskDialog assignees', () => {
  it('lists workspace members so one can be selected', async () => {
    const user = userEvent.setup();
    const onSave = renderDialog(members);

    const trigger = screen.getByRole('button', { name: /Ada Lovelace/ });
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    const grace = await screen.findByRole('button', { name: /Grace Hopper/ });
    expect(grace).toBeInTheDocument();

    await user.click(grace);
    await user.type(screen.getByPlaceholderText('Task name...'), 'Informatie uitbereiden');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeIds: ['user_ada', 'user_grace'],
      }),
    );
  });

  it('does not pretend a missing directory entry is zero assignees', () => {
    renderDialog([]);

    expect(screen.getByRole('button', { name: 'Assignees' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '0 assignees' })).not.toBeInTheDocument();
  });
});
