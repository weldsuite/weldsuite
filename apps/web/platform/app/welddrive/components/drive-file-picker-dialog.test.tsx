import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';

const state = vi.hoisted(() => ({
  files: [] as unknown[],
  isLoading: false,
  isError: false,
  hasMore: false,
  calls: [] as Record<string, unknown>[],
}));

vi.mock('@/hooks/queries/use-drive-queries', () => ({
  useDriveFiles: (params: Record<string, unknown>) => {
    state.calls.push(params);
    return {
      data: state.isLoading || state.isError ? undefined : { success: true, data: state.files, pagination: { hasMore: state.hasMore } },
      isLoading: state.isLoading,
      isError: state.isError,
    };
  },
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
    expect(screen.getByRole('checkbox', { name: 'Service agreement.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'NDA.pdf' })).toBeInTheDocument();
    expect(screen.getByText(/^2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/^120 KB/)).toBeInTheDocument();
    expect(state.calls.at(-1)).toMatchObject({ type: 'pdf', pageSize: 100 });
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

  it('cancels', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
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
