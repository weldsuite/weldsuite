import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';

const state = vi.hoisted(() => ({
  files: [] as unknown[],
  /** What a folder holds, when one is opened. */
  folderFiles: [] as unknown[],
  folders: [] as unknown[],
  shared: { files: [] as unknown[], folders: [] as unknown[] },
  isLoading: false,
  isError: false,
  hasMore: false,
  calls: [] as Record<string, unknown>[],
}));

vi.mock('@/hooks/queries/use-drive-queries', () => ({
  useDriveFiles: (params: Record<string, unknown>) => {
    state.calls.push(params);
    // As app-api answers: a folder's files, only the top level for `folderId: ''`, else everything.
    let files = state.files;
    if (params.folderId) files = state.folderFiles;
    else if (params.folderId === '') files = state.files.filter((f) => !f.folderId);
    return {
      data: state.isLoading || state.isError ? undefined : { success: true, data: files, pagination: { hasMore: state.hasMore } },
      isLoading: state.isLoading,
      isError: state.isError,
    };
  },
  useDriveFolders: (parentId: string | null, enabled: boolean) => ({
    data: enabled ? { success: true, data: parentId ? [] : state.folders } : undefined,
    isLoading: false,
    isError: false,
  }),
  useSharedWithMe: (enabled: boolean) => ({ data: enabled ? state.shared : undefined, isLoading: false, isError: false }),
}));

import { DriveFilePickerDialog } from './drive-file-picker-dialog';

const tp = en.welddrive.picker.files;

function file(overrides: Partial<UnifiedFile> = {}): UnifiedFile {
  return {
    id: 'fil_1',
    name: 'Service agreement.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 2 * 1024 * 1024,
    url: null,
    thumbnailUrl: null,
    source: 'drive',
    sourceLabel: 'My Drive',
    navigateTo: null,
    folderId: null,
    isStarred: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    uploadedById: 'user_1',
    ...overrides,
  };
}

const onClose = vi.fn();
const onConfirm = vi.fn<(files: UnifiedFile[]) => Promise<void>>();

function renderPicker(props: Partial<React.ComponentProps<typeof DriveFilePickerDialog>> = {}) {
  render(
    <I18nProvider initialLanguage="en">
      <DriveFilePickerDialog
        title="Add from WeldDrive"
        description="Choose the PDFs."
        confirmLabel="Add"
        pendingLabel="Adding…"
        fileType="pdf"
        onConfirm={onConfirm}
        onClose={onClose}
        {...props}
      />
    </I18nProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  state.files = [file(), file({ id: 'fil_2', name: 'NDA.pdf', fileSize: 120 * 1024 }), file({ id: 'fil_3', name: 'Offer.pdf', fileSize: 500 * 1024 })];
  state.folderFiles = [];
  state.folders = [];
  state.shared = { files: [], folders: [] };
  state.isLoading = false;
  state.isError = false;
  state.hasMore = false;
  state.calls = [];
  onClose.mockReset();
  onConfirm.mockReset();
  onConfirm.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Drive file picker', () => {
  it('lists the files of the type asked for, with their size', () => {
    renderPicker();
    expect(screen.getByText('Add from WeldDrive')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: tp.tabs.recent })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('checkbox', { name: 'Service agreement.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'NDA.pdf' })).toBeInTheDocument();
    expect(screen.getByText(/^2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/^120 KB/)).toBeInTheDocument();
    expect(state.calls.at(-1)).toMatchObject({ type: 'pdf', pageSize: 100 });
  });

  it('puts the recent files under the date they were last changed, newest first', () => {
    state.files = [file({ id: 'fil_old', name: 'Old.pdf', updatedAt: '2020-01-01T10:00:00.000Z' }), file({ id: 'fil_new', name: 'New.pdf', updatedAt: new Date().toISOString() })];
    renderPicker();
    const today = screen.getByText(tp.groups.today);
    const older = screen.getByText(tp.groups.older);
    expect(today.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(tp.groups.yesterday)).toBeNull();
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['New.pdf', 'Old.pdf']);
  });

  it('searches by name', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByRole('searchbox', { name: tp.searchPlaceholder }), 'nda');
    await waitFor(() => expect(state.calls.at(-1)).toMatchObject({ type: 'pdf', search: 'nda' }));
  });

  it('leaves out files the caller does not accept', () => {
    renderPicker({ accept: (candidate) => candidate.name !== 'NDA.pdf' });
    expect(screen.queryByRole('checkbox', { name: 'NDA.pdf' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Offer.pdf' })).toBeInTheDocument();
  });

  it('hands over the chosen files, and keeps the choice while it works', async () => {
    let finish: () => void = () => undefined;
    onConfirm.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    renderPicker();

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Service agreement.pdf' }));
    await user.click(screen.getByRole('checkbox', { name: 'Offer.pdf' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: 'fil_1' }), expect.objectContaining({ id: 'fil_3' })]);
    // Busy: nothing can be changed or cancelled, and the dialog is still open.
    expect(await screen.findByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.common.actions.cancel })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('stops at the number of files that fit', async () => {
    const user = userEvent.setup();
    renderPicker({ maxSelect: 1 });
    expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'NDA.pdf' }));
    expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Offer.pdf' })).toBeDisabled();
    // The chosen one can still be taken back.
    expect(screen.getByRole('checkbox', { name: 'NDA.pdf' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'NDA.pdf' }));
    expect(screen.getByRole('checkbox', { name: 'Offer.pdf' })).toBeEnabled();
  });

  it('cancels, or closes with the X', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();

    renderPicker();
    await user.click(screen.getByRole('button', { name: en.common.actions.close }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows My Drive: its folders and the files outside them, and opens a folder in place', async () => {
    state.files = [file({ id: 'fil_root', name: 'Root.pdf' }), file({ id: 'fil_nested', name: 'Nested.pdf', folderId: 'fld_1' })];
    state.folders = [{ id: 'fld_1', name: 'Contracts', parentId: null, color: null }];
    state.folderFiles = [file({ id: 'fil_nested', name: 'Nested.pdf', folderId: 'fld_1' })];
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('tab', { name: tp.tabs.myDrive }));
    // The top level is asked of the server, not filtered from the newest files.
    expect(state.calls).toContainEqual(expect.objectContaining({ type: 'pdf', folderId: '' }));
    expect(screen.getByRole('checkbox', { name: 'Root.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Nested.pdf' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Contracts' }));
    expect(state.calls.at(-1)).toMatchObject({ type: 'pdf', folderId: 'fld_1' });
    expect(screen.getByRole('checkbox', { name: 'Nested.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Root.pdf' })).toBeNull();

    // Back up through the breadcrumb.
    await user.click(screen.getByRole('button', { name: tp.tabs.myDrive }));
    expect(screen.getByRole('checkbox', { name: 'Root.pdf' })).toBeInTheDocument();
  });

  it('shows what teammates shared, of the type asked for', async () => {
    state.shared = { files: [file({ id: 'fil_s', name: 'Shared.pdf' }), file({ id: 'fil_d', name: 'Notes.docx', fileType: 'document' })], folders: [] };
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('tab', { name: tp.tabs.shared }));
    expect(screen.getByRole('checkbox', { name: 'Shared.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Notes.docx' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Service agreement.pdf' })).toBeNull();
  });

  it('hands files chosen on the Upload tab to the caller, and closes', async () => {
    const onFiles = vi.fn();
    const user = userEvent.setup();
    renderPicker({ upload: { accept: 'application/pdf', onFiles } });

    await user.click(screen.getByRole('tab', { name: tp.tabs.upload }));
    const pdf = new File(['%PDF-1.7'], 'contract.pdf', { type: 'application/pdf' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, pdf);

    expect(onFiles).toHaveBeenCalledWith([pdf]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no Upload tab unless the caller takes uploads', () => {
    renderPicker();
    expect(screen.queryByRole('tab', { name: tp.tabs.upload })).toBeNull();
  });

  it('says it is loading', () => {
    state.isLoading = true;
    renderPicker();
    expect(screen.getByText(tp.loading)).toBeInTheDocument();
  });

  it('says when the files could not be loaded', () => {
    state.isError = true;
    renderPicker();
    expect(screen.getByText(tp.loadFailed)).toBeInTheDocument();
  });

  it('says when there are no files', () => {
    state.files = [];
    renderPicker();
    expect(screen.getByText(tp.empty)).toBeInTheDocument();
  });

  it('says when there are more files than it shows', () => {
    state.hasMore = true;
    renderPicker();
    expect(screen.getByText('Showing the first 100 files. Search to find others.')).toBeInTheDocument();
  });
});
