import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Task } from '@/hooks/use-crm-tasks';
import { TaskDialog } from './task-dialog';

vi.mock('@/hooks/use-file-upload', () => ({
  useFileUpload: () => ({ uploadFile: vi.fn(), isUploading: false, progress: 0, currentFileName: '' }),
}));

vi.mock('@/hooks/queries/use-github-queries', () => ({
  useLinkedRepos: () => ({ data: { data: [] } }),
}));

type Props = ComponentProps<typeof TaskDialog>;

const BASE: Omit<Props, 'onSave' | 'onUpdate'> = {
  open: true,
  onOpenChange: () => {},
  editingTask: null,
  availableAssignees: [
    { id: 'user_ada', name: 'Ada Lovelace' },
    { id: 'user_grace', name: 'Grace Hopper' },
  ],
  availableCompanies: [{ id: 'proj_1', name: 'Website' }],
  availableStatuses: [
    { id: 'todo', label: 'To Do' },
    { id: 'doing', label: 'Doing', color: '#f59e0b' },
  ],
  availableLabels: [{ id: 'lab_1', name: 'Bug', color: '#ef4444' }],
  defaultStatus: 'todo',
  recordRowLabel: 'Project',
  recordSearchPlaceholder: 'Search projects',
  isPending: false,
};

function renderDialog(props: Partial<Props> = {}) {
  const onSave = vi.fn();
  const onUpdate = vi.fn();
  render(
    <I18nProvider initialLanguage="en">
      <TaskDialog {...BASE} onSave={onSave} onUpdate={onUpdate} {...props} />
    </I18nProvider>,
  );
  return { onSave, onUpdate };
}

/** Opens a row of the properties column and picks one of its options. */
async function pick(user: UserEvent, row: RegExp, option: string | RegExp) {
  await user.click(screen.getByRole('button', { name: row }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('TaskDialog properties', () => {
  it('saves the status, priority and duration picked in their rows', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByPlaceholderText('Task name...'), 'Write the launch post');
    await pick(user, /^Status/, 'Doing');
    await pick(user, /^Priority/, 'High');
    await pick(user, /^Priority/, 'None');
    await pick(user, /^Priority/, 'High');
    await pick(user, /^Duration/, '1h');
    await pick(user, /^Duration/, 'None');
    await pick(user, /^Duration/, 'Custom');
    await user.type(screen.getByRole('spinbutton', { name: 'Custom (minutes)' }), '25');
    await user.keyboard('{Escape}');
    await pick(user, /^Due date/, 'None');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Write the launch post', status: 'doing', priority: 'high', duration: 25 }));
  });

  it('picks, clears and creates labels', async () => {
    const user = userEvent.setup();
    const onCreateLabel = vi.fn().mockResolvedValue({ id: 'lab_2', name: 'Docs', color: '#3b82f6' });
    const { onSave } = renderDialog({ onCreateLabel });

    await user.type(screen.getByPlaceholderText('Task name...'), 'Fix the docs');
    await user.click(screen.getByRole('button', { name: /^Labels/ }));
    await user.click(await screen.findByRole('option', { name: /Bug/ }));
    await user.click(screen.getByRole('option', { name: 'None' }));
    await user.click(screen.getByRole('option', { name: /Bug/ }));
    await user.click(screen.getByRole('option', { name: 'Create label' }));
    await user.type(screen.getByRole('textbox', { name: 'Type to create a label' }), 'Docs{Enter}');
    await waitFor(() => expect(onCreateLabel).toHaveBeenCalledWith(expect.objectContaining({ name: 'Docs' })));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ labels: ['lab_1', 'lab_2'] }));
  });

  it('clears the assignees with None and picks them again', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ defaultAssignee: 'user_ada' });

    await user.type(screen.getByPlaceholderText('Task name...'), 'Plan the week');
    await pick(user, /^Assignees/, 'None');
    await pick(user, /^Assignees/, /Grace Hopper/);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ assigneeIds: ['user_grace'] }));
  });

  it('repeats on a custom schedule', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByPlaceholderText('Task name...'), 'Water the plants');
    await pick(user, /^Repeat/, 'Weekly');
    await pick(user, /^Repeat/, 'Never');
    await pick(user, /^Repeat/, 'Custom');
    // The interval never drops below 1 while typing, so set it in one go.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Every' }), { target: { value: '3' } });
    await user.click(screen.getByRole('button', { name: /Days/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Weeks/ }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ repeat: { frequency: 'custom', interval: 3, unit: 'weeks' } }));
  });

  it('links a project, or makes one from the search', async () => {
    const user = userEvent.setup();
    const onCreateRecord = vi.fn().mockResolvedValue({ id: 'proj_2', name: 'Acme' });
    const { onSave } = renderDialog({
      hideRecord: false,
      onCreateRecord,
      createRecordLabels: { create: 'Create project', namePlaceholder: 'Project name' },
    });

    await user.type(screen.getByPlaceholderText('Task name...'), 'Kick-off');
    // Picking a project keeps the picker open, as a search may follow.
    await pick(user, /^Project/, /Website/);
    await user.type(screen.getByPlaceholderText('Search projects'), 'Acme');
    await user.click(screen.getByRole('option', { name: 'Create project' }));
    const name = screen.getByRole('textbox', { name: 'Project name' });
    expect((name as HTMLInputElement).value).toBe('Acme');
    await user.type(name, ' Inc');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onCreateRecord).toHaveBeenCalledWith('Acme Inc'));
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ linkedCompanyId: 'proj_2', personId: undefined }));
  });

  it('does not make a project without a name', async () => {
    const user = userEvent.setup();
    const onCreateRecord = vi.fn();
    renderDialog({ hideRecord: false, onCreateRecord, createRecordLabels: { create: 'Create project', namePlaceholder: 'Project name' } });

    await user.click(screen.getByRole('button', { name: /^Project/ }));
    await user.click(await screen.findByRole('option', { name: 'Create project' }));
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), '{Enter}');
    expect(onCreateRecord).not.toHaveBeenCalled();
  });

  it('unlinks the project when it is picked again', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ hideRecord: false, defaultRecord: 'proj_1' });

    await user.type(screen.getByPlaceholderText('Task name...'), 'Loose task');
    await pick(user, /^Project/, /Website/);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ linkedCompanyId: undefined }));
  });

  it('shows a fixed record as a row that cannot be changed', () => {
    renderDialog({ hideRecord: false, lockedRecord: { id: 'company_1', name: 'Acme' } });
    expect((screen.getByRole('button', { name: /Acme/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers nobody who left the workspace as a new assignee', async () => {
    const user = userEvent.setup();
    renderDialog({ availableAssignees: [{ id: 'user_ada', name: 'Ada Lovelace' }, { id: 'user_old', name: 'Old Colleague', departed: true }] });

    await user.click(screen.getByRole('button', { name: /^Assignees/ }));
    expect(await screen.findByRole('option', { name: /Ada Lovelace/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Old Colleague/ })).toBeNull();
  });

  it('keeps what is typed in the description and takes attached files', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByPlaceholderText('Task name...'), 'Notes');
    const description = screen.getByRole('textbox', { name: 'Add description...' });
    description.innerHTML = 'Bring the slides';
    fireEvent.input(description);
    fireEvent.keyDown(description, { key: 'a' });
    await user.click(screen.getByRole('button', { name: /^Attachments/ }));
    const files = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(files, { target: { files: [new File(['x'], 'agenda.txt', { type: 'text/plain' })] } });
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ description: 'Bring the slides' }));
  });
});

describe('TaskDialog editing', () => {
  it('saves a task linked to a person on the person side, and closes from the cross', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const task = {
      id: 'task_1',
      title: 'Call back',
      description: '',
      status: 'todo',
      priority: null,
      assignees: [{ id: 'user_ada', name: 'Ada Lovelace' }],
      linkedPerson: { id: 'person_1', name: 'Linus' },
      labels: [],
    } as unknown as Task;
    const { onUpdate } = renderDialog({ editingTask: task, hideRecord: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).toHaveBeenCalledWith('task_1', expect.objectContaining({ linkedPerson: { id: 'person_1', name: 'Linus' }, linkedCompany: null }));

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('TaskDialog editing a task linked to a company', () => {
  it('saves it on the company side', async () => {
    const user = userEvent.setup();
    const task = { id: 'task_2', title: 'Send the quote', description: '', status: 'todo', priority: null, linkedCompany: { id: 'company_1', name: 'Acme' }, labels: [] } as unknown as Task;
    const { onUpdate } = renderDialog({ editingTask: task, hideRecord: false });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).toHaveBeenCalledWith('task_2', expect.objectContaining({ linkedCompany: { id: 'company_1', name: 'Acme' }, linkedPerson: null }));
  });

  it('saves a task linked to nothing without a link', async () => {
    const user = userEvent.setup();
    const task = { id: 'task_3', title: 'Tidy up', description: '', status: 'todo', priority: null, labels: [] } as unknown as Task;
    const { onUpdate } = renderDialog({ editingTask: task, hideRecord: false });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).toHaveBeenCalledWith('task_3', expect.objectContaining({ linkedCompany: null, linkedPerson: null }));
  });
});

describe('TaskDialog "Create more"', () => {
  function Page({ onSave }: Readonly<{ onSave: (data: { title: string }) => void }>) {
    const [open, setOpen] = useState(true);
    return (
      <I18nProvider initialLanguage="en">
        <TaskDialog
          {...BASE}
          allowCreateMore
          open={open}
          onOpenChange={setOpen}
          onSave={(data) => {
            onSave(data);
            setOpen(false);
          }}
          onUpdate={() => {}}
        />
      </I18nProvider>
    );
  }

  it('comes back empty for the next task after a save, keeping the dialog open', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Page onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Create more' }));
    await user.type(screen.getByPlaceholderText('Task name...'), 'First');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'First' }));

    await waitFor(() => expect((screen.getByPlaceholderText('Task name...') as HTMLTextAreaElement).value).toBe(''));
    await user.type(screen.getByPlaceholderText('Task name...'), 'Second');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Second' }));
  });
});
