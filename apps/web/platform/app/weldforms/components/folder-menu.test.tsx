import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { FormFolder } from '@weldsuite/app-api-client/schemas/weldforms';
import { ALL_FOLDERS, FolderMenu, NO_FOLDER } from './folder-menu';

const tf = en.weldforms.folders;

let allowed = true;
const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();
const removeMutateAsync = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('sonner', () => ({
  toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}));

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: () => allowed,
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

vi.mock('@/hooks/queries/use-weldforms-queries', () => ({
  useCreateFormFolder: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useUpdateFormFolder: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useDeleteFormFolder: () => ({ mutateAsync: removeMutateAsync, isPending: false }),
}));

const folder = (id: string, name: string, formCount: number): FormFolder => ({
  id,
  name,
  position: 0,
  formCount,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const folders = [folder('f1', 'Marketing', 3), folder('f2', 'Sales', 5)];

function setup(selected: string = ALL_FOLDERS, totalCount: number | null = 12) {
  const onSelect = vi.fn();
  render(<FolderMenu folders={folders} selected={selected} onSelect={onSelect} totalCount={totalCount} />);
  return { onSelect };
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: new RegExp(`^${tf.title}:`) }), { key: 'Enter' });
}

describe('FolderMenu', () => {
  beforeEach(() => {
    allowed = true;
    createMutateAsync.mockReset();
    updateMutateAsync.mockReset();
    removeMutateAsync.mockReset();
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  it('labels the trigger with all forms, the picked folder or no folder', () => {
    const { unmount } = render(<FolderMenu folders={folders} selected={ALL_FOLDERS} onSelect={vi.fn()} totalCount={null} />);
    expect(screen.getByRole('button', { name: `${tf.title}: ${tf.all}` })).toBeTruthy();
    unmount();

    const second = render(<FolderMenu folders={folders} selected="f2" onSelect={vi.fn()} totalCount={null} />);
    expect(screen.getByRole('button', { name: `${tf.title}: Sales` })).toBeTruthy();
    second.unmount();

    render(<FolderMenu folders={folders} selected={NO_FOLDER} onSelect={vi.fn()} totalCount={null} />);
    expect(screen.getByRole('button', { name: `${tf.title}: ${tf.none}` })).toBeTruthy();
  });

  it('lists all forms, each folder with its count, and the forms outside a folder', () => {
    setup();
    openMenu();

    const all = screen.getByRole('menuitemradio', { name: new RegExp(tf.all) });
    expect(within(all).getByText('12')).toBeTruthy();
    expect(within(screen.getByRole('menuitemradio', { name: /Marketing/ })).getByText('3')).toBeTruthy();
    expect(within(screen.getByRole('menuitemradio', { name: /Sales/ })).getByText('5')).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: tf.none })).toBeTruthy();
  });

  it('shows no total while it is unknown', () => {
    setup(ALL_FOLDERS, null);
    openMenu();
    expect(screen.getByRole('menuitemradio', { name: tf.all })).toBeTruthy();
  });

  it('reports the choice of a folder, all forms and no folder', () => {
    const { onSelect } = setup('f1');
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sales/ }));
    expect(onSelect).toHaveBeenCalledWith('f2');

    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: tf.none }));
    expect(onSelect).toHaveBeenCalledWith(NO_FOLDER);

    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(tf.all) }));
    expect(onSelect).toHaveBeenCalledWith(ALL_FOLDERS);
  });

  it('hides create, rename and delete without the create permission', () => {
    allowed = false;
    setup('f1');
    openMenu();
    expect(screen.getByRole('menuitemradio', { name: /Marketing/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: tf.new })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: tf.renameFolder })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: tf.deleteFolder })).toBeNull();
  });

  it('offers rename and delete only for a picked folder', () => {
    setup(ALL_FOLDERS);
    openMenu();
    expect(screen.getByRole('menuitem', { name: tf.new })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: tf.renameFolder })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: tf.deleteFolder })).toBeNull();
  });

  it('creates a folder and selects it', async () => {
    createMutateAsync.mockResolvedValue({ data: { id: 'f9' } });
    const { onSelect } = setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.new }));

    const input = await screen.findByLabelText(tf.name);
    expect((input as HTMLInputElement).value).toBe('');
    const save = screen.getByRole('button', { name: en.common.actions.save });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '  Support  ' } });
    fireEvent.click(save);

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledWith({ name: 'Support' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('f9'));
    await waitFor(() => expect(screen.queryByLabelText(tf.name)).toBeNull());
  });

  it('saves on Enter and ignores other keys', async () => {
    createMutateAsync.mockResolvedValue({ data: { id: 'f9' } });
    setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.new }));

    const input = await screen.findByLabelText(tf.name);
    fireEvent.change(input, { target: { value: 'Support' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(createMutateAsync).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledWith({ name: 'Support' }));
  });

  it('does not save a blank name', async () => {
    setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.new }));

    const input = await screen.findByLabelText(tf.name);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and reports a failed save', async () => {
    createMutateAsync.mockRejectedValue(new Error('boom'));
    const { onSelect } = setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.new }));

    fireEvent.change(await screen.findByLabelText(tf.name), { target: { value: 'Support' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(tf.saveFailed));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByLabelText(tf.name)).toBeTruthy();
  });

  it('closes the dialog on cancel', async () => {
    setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.new }));
    await screen.findByLabelText(tf.name);

    fireEvent.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    await waitFor(() => expect(screen.queryByLabelText(tf.name)).toBeNull());
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('closes the dialog on escape', async () => {
    setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.new }));
    const input = await screen.findByLabelText(tf.name);

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText(tf.name)).toBeNull());
  });

  it('renames the picked folder', async () => {
    updateMutateAsync.mockResolvedValue({});
    setup('f1');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.renameFolder }));

    const input = (await screen.findByLabelText(tf.name)) as HTMLInputElement;
    expect(input.value).toBe('Marketing');
    expect(screen.getByRole('heading', { name: tf.rename })).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Growth' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledWith({ id: 'f1', name: 'Growth' }));
    expect(createMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText(tf.name)).toBeNull());
  });

  it('asks before deleting the picked folder, then deletes it and goes back to all forms', async () => {
    removeMutateAsync.mockResolvedValue(undefined);
    const { onSelect } = setup('f1');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.deleteFolder }));

    expect(await screen.findByText(tf.deleteTitle)).toBeTruthy();
    expect(screen.getByText(tf.deleteDescription.replace('{name}', 'Marketing'))).toBeTruthy();
    expect(removeMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: en.common.actions.delete }));

    await waitFor(() => expect(removeMutateAsync).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(tf.deleted));
    expect(onSelect).toHaveBeenCalledWith(ALL_FOLDERS);
    await waitFor(() => expect(screen.queryByText(tf.deleteTitle)).toBeNull());
  });

  it('reports a failed delete and keeps the selection', async () => {
    removeMutateAsync.mockRejectedValue(new Error('boom'));
    const { onSelect } = setup('f1');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.deleteFolder }));
    await screen.findByText(tf.deleteTitle);

    fireEvent.click(screen.getByRole('button', { name: en.common.actions.delete }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(tf.deleteFailed));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    setup('f1');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: tf.deleteFolder }));
    await screen.findByText(tf.deleteTitle);

    fireEvent.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    await waitFor(() => expect(screen.queryByText(tf.deleteTitle)).toBeNull());
    expect(removeMutateAsync).not.toHaveBeenCalled();
  });
});
