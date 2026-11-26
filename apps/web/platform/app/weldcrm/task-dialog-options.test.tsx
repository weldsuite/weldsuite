import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
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

function renderDialog(props: Partial<ComponentProps<typeof TaskDialog>> = {}) {
  render(
    <I18nProvider initialLanguage="en">
      <TaskDialog
        open
        onOpenChange={() => {}}
        editingTask={null}
        availableAssignees={[]}
        availableCompanies={[]}
        hideRecord
        onSave={vi.fn()}
        onUpdate={() => {}}
        isPending={false}
        {...props}
      />
    </I18nProvider>,
  );
}

describe('TaskDialog "Create more"', () => {
  it('is not offered unless the caller fills a list', () => {
    renderDialog();
    expect(screen.queryByRole('switch', { name: 'Create more' })).not.toBeInTheDocument();
  });

  it('is offered where the caller allows it', () => {
    renderDialog({ allowCreateMore: true });
    expect(screen.getByRole('switch', { name: 'Create more' })).toBeInTheDocument();
  });
});

describe('TaskDialog record picker', () => {
  it('forgets its search after making a record from it', async () => {
    const user = userEvent.setup();
    const onRecordSearchChange = vi.fn();
    const onCreateRecord = vi.fn().mockResolvedValue({ id: 'proj_2', name: 'Acme' });
    renderDialog({
      hideRecord: false,
      availableCompanies: [{ id: 'proj_1', name: 'Website' }],
      onRecordSearchChange,
      onCreateRecord,
      createRecordLabels: { create: 'Create project', namePlaceholder: 'Project name' },
      recordSearchPlaceholder: 'Search records',
    });

    await user.click(screen.getByRole('button', { name: /Linked to/ }));
    await user.type(screen.getByPlaceholderText('Search records'), 'Acme');
    await user.click(screen.getByRole('option', { name: 'Create project' }));
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), '{Enter}');
    await waitFor(() => expect(onCreateRecord).toHaveBeenCalledWith('Acme'));
    await waitFor(() => expect(onRecordSearchChange).toHaveBeenLastCalledWith(''));

    await user.click(screen.getByRole('button', { name: /Linked to/ }));
    await user.click(screen.getByRole('option', { name: 'Create project' }));
    expect((screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement).value).toBe('');
  });

  it('forgets its search when it closes, here and in the server search', async () => {
    const user = userEvent.setup();
    const onRecordSearchChange = vi.fn();
    renderDialog({
      hideRecord: false,
      availableCompanies: [
        { id: 'company_1', name: 'Acme' },
        { id: 'company_2', name: 'Globex' },
      ],
      onRecordSearchChange,
      recordSearchPlaceholder: 'Search records',
    });

    await user.click(screen.getByRole('button', { name: /Linked to/ }));
    await user.type(screen.getByPlaceholderText('Search records'), 'Ac');
    await waitFor(() => expect(onRecordSearchChange).toHaveBeenLastCalledWith('Ac'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(onRecordSearchChange).toHaveBeenLastCalledWith(''));

    await user.click(screen.getByRole('button', { name: /Linked to/ }));
    expect((screen.getByPlaceholderText('Search records') as HTMLInputElement).value).toBe('');
  });
});
