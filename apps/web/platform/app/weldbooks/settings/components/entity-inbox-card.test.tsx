import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  canEdit: true,
  inbox: undefined as unknown,
  inboxError: false,
  save: vi.fn(),
  saveError: undefined as unknown,
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canEdit }));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  useEntityInbox: () => ({ data: env.inboxError ? undefined : env.inbox, isError: env.inboxError, refetch: vi.fn() }),
  useSetEntityInbox: () => ({
    mutate: (vars: unknown, options: { onSuccess?: () => void }) => {
      env.save(vars);
      if (!env.saveError) options.onSuccess?.();
    },
    isPending: false,
    isError: Boolean(env.saveError),
    error: env.saveError ?? null,
  }),
}));

import { renderWithProviders } from '../../invoices/components/test-utils';
import { EntityInboxCard } from './entity-inbox-card';

beforeEach(() => {
  env.canEdit = true;
  env.inboxError = false;
  env.inbox = { entityId: 'ent_1', email: null, workspaceAddress: false, autoScanEnabled: false };
  env.saveError = undefined;
  env.save.mockReset();
});

describe('EntityInboxCard', () => {
  it('explains what the address is for and that scanning starts by itself', () => {
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);

    expect(screen.getByText('Invoices and receipts e-mailed to this address land in the Inbox of this entity.')).toBeInTheDocument();
    expect(screen.getByText('Scanning starts by itself when an address is set.')).toBeInTheDocument();
    expect(screen.getByText('No address set yet.')).toBeInTheDocument();
  });

  it('shows the current address and the workspace note', () => {
    env.inbox = { entityId: 'ent_1', email: 'books@acme.weldsuite.org', workspaceAddress: true, autoScanEnabled: true };
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);

    expect(screen.getByTestId('entity-inbox-email')).toHaveTextContent('books@acme.weldsuite.org');
    expect(screen.getByText('This is the address of your workspace, shared by all entities.')).toBeInTheDocument();
  });

  it('saves a new address for the entity and says so', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);

    expect(screen.getByRole('button', { name: 'Save address' })).toBeDisabled();
    await user.type(screen.getByLabelText('E-mail address'), '  invoices@acme.nl ');
    await user.click(screen.getByRole('button', { name: 'Save address' }));

    expect(env.save).toHaveBeenCalledWith({ entityId: 'ent_1', email: 'invoices@acme.nl' });
    expect(screen.getByText('Address saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail address')).toHaveValue('');
  });

  it('says an address another entity uses is taken (409)', async () => {
    const user = userEvent.setup();
    env.saveError = Object.assign(new Error('taken'), { status: 409 });
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);

    await user.type(screen.getByLabelText('E-mail address'), 'x@acme.nl');
    await user.click(screen.getByRole('button', { name: 'Save address' }));

    expect(screen.getByRole('alert')).toHaveTextContent('That address is already used by another entity.');
    expect(screen.getByLabelText('E-mail address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says a bad address is not valid (400) and words any other failure plainly', async () => {
    const user = userEvent.setup();
    env.saveError = Object.assign(new Error('bad'), { status: 400 });
    const { unmount } = renderWithProviders(<EntityInboxCard entityId="ent_1" />);
    await user.type(screen.getByLabelText('E-mail address'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid e-mail address.');
    unmount();

    env.saveError = Object.assign(new Error('boom'), { status: 500 });
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);
    await user.type(screen.getByLabelText('E-mail address'), 'a@b.nl');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The address could not be saved.');
  });

  it('is read-only without permission to update', () => {
    env.canEdit = false;
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);
    expect(screen.queryByLabelText('E-mail address')).not.toBeInTheDocument();
  });

  it('says when the address could not be loaded', () => {
    env.inboxError = true;
    renderWithProviders(<EntityInboxCard entityId="ent_1" />);
    expect(screen.getByText('The inbox address could not be loaded.')).toBeInTheDocument();
  });
});
