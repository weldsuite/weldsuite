/**
 * "Who has access" in the New vault dialog: the creator is never offered (they
 * are the first manager anyway), and the teammates picked are sent with the
 * create request at the role chosen for them.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const createVault = vi.fn();

vi.mock('@weldsuite/i18n/client', () => ({
  // Keys echo back, with the name appended so labels stay distinct.
  useTranslations: () => (key: string, params?: { name?: string }) =>
    params?.name ? `${key} ${params.name}` : key,
}));

vi.mock('@/hooks/queries/use-weldpass-passwords-queries', () => ({
  useCreateWeldPassVault: () => ({ mutateAsync: createVault, isPending: false }),
  useWeldPassTeammates: () => ({
    data: [
      { userId: 'user_me', name: 'Me', email: 'me@acme.com', picture: null },
      { userId: 'user_bob', name: 'Bob', email: 'bob@acme.com', picture: null },
      { userId: 'user_carol', name: 'Carol', email: 'carol@acme.com', picture: null },
    ],
  }),
}));

import { CreateVaultDialog } from './create-vault-dialog';

const P = 'weldpass.passwords.';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  createVault.mockReset();
  createVault.mockResolvedValue({ data: { id: 'wpk_1', name: 'Marketing' } });
});

function renderDialog() {
  const onCreated = vi.fn();
  render(<CreateVaultDialog currentUserId="user_me" onClose={vi.fn()} onCreated={onCreated} />);
  return { onCreated, user: userEvent.setup() };
}

async function pickTeammate(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: `${P}members.pickTeammate` }));
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }));
  await user.click(screen.getByRole('button', { name: `${P}members.add` }));
}

describe('CreateVaultDialog · who has access', () => {
  it('creates a vault for the creator alone when nobody is picked', async () => {
    const { user, onCreated } = renderDialog();
    expect(screen.getByText(`${P}vaultForm.accessOnlyYou`)).toBeInTheDocument();

    await user.type(screen.getByLabelText(`${P}vaultForm.name`), 'Marketing');
    await user.click(screen.getByRole('button', { name: `${P}vaultForm.create` }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createVault).toHaveBeenCalledWith({ name: 'Marketing', description: null, members: [] });
  });

  it('never offers the creator', async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole('combobox', { name: `${P}members.pickTeammate` }));
    expect(await screen.findByRole('option', { name: /^Bob/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Me/ })).not.toBeInTheDocument();
  });

  it('sends the picked teammates with their roles, minus any removed', async () => {
    const { user } = renderDialog();

    await pickTeammate(user, 'Bob');
    await pickTeammate(user, 'Carol');
    expect(screen.queryByText(`${P}vaultForm.accessOnlyYou`)).not.toBeInTheDocument();

    // Bob becomes an editor; Carol is taken off again.
    await user.click(screen.getByRole('combobox', { name: `${P}members.roleFor Bob` }));
    await user.click(await screen.findByRole('option', { name: `${P}roles.editor` }));
    await user.click(screen.getByRole('button', { name: `${P}members.remove Carol` }));

    await user.type(screen.getByLabelText(`${P}vaultForm.name`), 'Marketing');
    await user.click(screen.getByRole('button', { name: `${P}vaultForm.create` }));

    await waitFor(() => expect(createVault).toHaveBeenCalled());
    expect(createVault).toHaveBeenCalledWith({
      name: 'Marketing',
      description: null,
      members: [{ userId: 'user_bob', role: 'editor' }],
    });
  });
});
