/**
 * The detail dialog's secrecy rules: nothing is revealed by opening it, a
 * reveal happens on an explicit action, and a revealed value goes away again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  WeldPassItem,
  WeldPassRevealedItem,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';

const revealItem = vi.fn();
const deleteItem = vi.fn();
const restoreItem = vi.fn();

vi.mock('@weldsuite/i18n/client', () => ({
  // Keys echo back, with params appended so interpolation is visible.
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/hooks/queries/use-weldpass-passwords-queries', () => ({
  useRevealWeldPassItem: () => ({ mutateAsync: revealItem, isPending: false }),
  useDeleteWeldPassItem: () => ({ mutateAsync: deleteItem, isPending: false }),
  useWeldPassTotp: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRestoreWeldPassItem: () => ({ mutateAsync: restoreItem, isPending: false }),
  useWeldPassItemVersions: () => ({
    data: [
      { id: 'wpiv_3', version: 3, action: 'updated', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'wpiv_2', version: 2, action: 'updated', createdAt: '2026-01-01T12:00:00.000Z' },
    ],
    isLoading: false,
    error: null,
  }),
}));

import { ItemDetailDialog } from './item-detail-dialog';

const item: WeldPassItem = {
  id: 'wpi_1',
  vaultId: 'wpv_1',
  type: 'login',
  title: 'GitHub',
  subtitle: 'dev@acme.com',
  url: 'https://github.com/login',
  host: 'github.com',
  hasTotp: false,
  passwordChangedAt: null,
  version: 3,
  createdBy: null,
  updatedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const revealed: WeldPassRevealedItem = {
  ...item,
  fields: { username: 'dev@acme.com', password: 'hunter2-hunter2', totp: '', notes: 'backup code 42' },
};

function renderDialog(overrides: Partial<Parameters<typeof ItemDetailDialog>[0]> = {}) {
  const props = {
    item,
    vaultName: 'Team',
    canEdit: true,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onMove: vi.fn(),
    onRestored: vi.fn(),
    ...overrides,
  };
  render(<ItemDetailDialog {...props} />);
  return props;
}

describe('ItemDetailDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revealItem.mockResolvedValue(revealed);
  });

  /** user-event installs its own clipboard, so the spy goes on after it. */
  function setupUser() {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    return { user, writeText };
  }

  it('shows the list fields and reveals nothing on open', () => {
    renderDialog();

    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByDisplayValue('dev@acme.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('hunter2-hunter2')).not.toBeInTheDocument();
    expect(revealItem).not.toHaveBeenCalled();
  });

  it('reveals on demand, once, and hides again without another request', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.reveal' }));
    expect(await screen.findByDisplayValue('hunter2-hunter2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('backup code 42')).toBeInTheDocument();
    expect(revealItem).toHaveBeenCalledTimes(1);
    expect(revealItem).toHaveBeenCalledWith({ vaultId: 'wpv_1', itemId: 'wpi_1' });

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.hide' }));
    expect(screen.queryByDisplayValue('hunter2-hunter2')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('backup code 42')).not.toBeInTheDocument();
    expect(revealItem).toHaveBeenCalledTimes(1);
  });

  it('copies the username without revealing anything', async () => {
    const { user, writeText } = setupUser();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.copyUsername' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('dev@acme.com'));
    expect(revealItem).not.toHaveBeenCalled();
  });

  it('reveals to copy the password but leaves it masked on screen', async () => {
    const { user, writeText } = setupUser();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.copyPassword' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hunter2-hunter2'));
    expect(revealItem).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue('hunter2-hunter2')).not.toBeInTheDocument();
  });

  it('copies from the already revealed value without another request', async () => {
    const { user, writeText } = setupUser();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.reveal' }));
    await screen.findByDisplayValue('hunter2-hunter2');
    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.copyPassword' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hunter2-hunter2'));
    expect(revealItem).toHaveBeenCalledTimes(1);
  });

  it('reveals before editing and hands the decrypted item to the form', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderDialog();

    await user.click(screen.getByRole('button', { name: /weldpass\.passwords\.detail\.edit/ }));

    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(revealed));
    expect(revealItem).toHaveBeenCalledTimes(1);
  });

  it('offers no write actions to a viewer', () => {
    renderDialog({ canEdit: false });

    for (const action of ['edit', 'move', 'delete']) {
      expect(
        screen.queryByRole('button', { name: new RegExp(`detail\\.${action}$`) }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole('tab', { name: 'weldpass.passwords.detail.history' }),
    ).not.toBeInTheDocument();
  });

  it('restores an earlier version from the History tab and drops the revealed copy', async () => {
    restoreItem.mockResolvedValue({});
    const user = userEvent.setup();
    const { onRestored } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.reveal' }));
    await screen.findByDisplayValue('hunter2-hunter2');

    await user.click(screen.getByRole('tab', { name: 'weldpass.passwords.detail.history' }));
    // Only the older version can be restored; the current one has no button.
    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.history.restore' }));

    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(restoreItem).toHaveBeenCalledWith({ vaultId: 'wpv_1', itemId: 'wpi_1', version: 2 });
    expect(screen.queryByDisplayValue('hunter2-hunter2')).not.toBeInTheDocument();
  });

  it('shows the API message when a reveal fails', async () => {
    revealItem.mockRejectedValueOnce(new Error('This needs the viewer role on the vault.'));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'weldpass.passwords.detail.reveal' }));

    expect(await screen.findByText('This needs the viewer role on the vault.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('hunter2-hunter2')).not.toBeInTheDocument();
  });
});
