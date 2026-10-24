import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { DriveFolder } from '@/lib/api/domains/welddrive';

const state = vi.hoisted(() => ({
  folders: [] as unknown[],
  isLoading: false,
  isError: false,
}));

vi.mock('@/hooks/queries/use-drive-queries', () => ({
  useAllDriveFolders: () => ({
    data: state.isLoading || state.isError ? undefined : { success: true, data: state.folders },
    isLoading: state.isLoading,
    isError: state.isError,
  }),
}));

import { DriveFolderPickerDialog, canAddFilesTo } from './drive-folder-picker-dialog';

const tp = en.welddrive.picker.folders;

function folder(overrides: Partial<DriveFolder>): DriveFolder {
  return {
    id: 'fld_1',
    name: 'Contracts',
    parentId: null,
    color: null,
    icon: null,
    createdById: 'user_1',
    generalAccess: 'restricted',
    metadata: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    deletedAt: null,
    accessRole: 'owner',
    ...overrides,
  } as DriveFolder;
}

const onClose = vi.fn();
const onPick = vi.fn<(folder: DriveFolder) => Promise<void>>();

function renderPicker(props: Partial<React.ComponentProps<typeof DriveFolderPickerDialog>> = {}) {
  render(
    <I18nProvider initialLanguage="en">
      <DriveFolderPickerDialog
        title="Choose a folder"
        description="Where the signed copy goes."
        confirmLabel="Use this folder"
        onPick={onPick}
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
  state.folders = [
    folder({ id: 'fld_contracts', name: 'Contracts' }),
    folder({ id: 'fld_2026', name: '2026', parentId: 'fld_contracts', accessRole: 'editor' }),
    folder({ id: 'fld_hr', name: 'HR files', accessRole: 'viewer' }),
  ];
  state.isLoading = false;
  state.isError = false;
  onClose.mockReset();
  onPick.mockReset();
  onPick.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('canAddFilesTo', () => {
  it('is true for an owner and an editor, false for a viewer', () => {
    expect(canAddFilesTo({ accessRole: 'owner' })).toBe(true);
    expect(canAddFilesTo({ accessRole: 'editor' })).toBe(true);
    expect(canAddFilesTo({ accessRole: 'viewer' })).toBe(false);
    // An older API answer carries no role: the server decides then.
    expect(canAddFilesTo({})).toBe(true);
  });
});

describe('Drive folder picker', () => {
  it('shows the folders as a tree, subfolders under their folder', () => {
    renderPicker();
    const names = screen.getAllByRole('button').map((button) => button.textContent);
    expect(names.indexOf('Contracts')).toBeLessThan(names.indexOf('2026'));
    expect(names.indexOf('2026')).toBeLessThan(names.findIndex((name) => name?.startsWith('HR files')));
  });

  it('shows a folder the member can only view, but does not let it be chosen', async () => {
    const user = userEvent.setup();
    renderPicker();
    const viewOnly = screen.getByRole('button', { name: new RegExp(`HR files\\s*${tp.viewOnly}`) });
    expect(viewOnly).toBeDisabled();
    await user.click(viewOnly);
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
  });

  it('hands over the chosen folder and closes once the caller is done', async () => {
    let finish: () => void = () => undefined;
    onPick.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    renderPicker();

    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '2026' }));
    expect(screen.getByRole('button', { name: '2026' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'fld_2026', name: '2026' }));
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('starts with the current folder chosen', () => {
    renderPicker({ selectedFolderId: 'fld_contracts' });
    expect(screen.getByRole('button', { name: 'Contracts' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled();
  });

  it('cancels', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says it is loading, when it failed, and when there are no folders', () => {
    state.isLoading = true;
    renderPicker();
    expect(screen.getByText(tp.loading)).toBeInTheDocument();
    cleanup();

    state.isLoading = false;
    state.isError = true;
    renderPicker();
    expect(screen.getByText(tp.loadFailed)).toBeInTheDocument();
    cleanup();

    state.isError = false;
    state.folders = [];
    renderPicker();
    expect(screen.getByText(tp.empty)).toBeInTheDocument();
  });
});
