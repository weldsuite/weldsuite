import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  entityId: 'ent_1' as string | null,
  inbox: undefined as unknown,
  isPending: false,
  isError: false,
  canManage: true,
}));

vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('../invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canManage }));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: env.entityId }) }));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  useEntityInbox: () => ({ data: env.inbox, isPending: env.isPending, isError: env.isError }),
}));

import { renderWithProviders } from '../invoices/components/test-utils';
import { InboxAddressCard } from './inbox-address-card';

beforeEach(() => {
  env.entityId = 'ent_1';
  env.isPending = false;
  env.isError = false;
  env.canManage = true;
  env.inbox = { entityId: 'ent_1', email: 'books@acme.weldsuite.org', workspaceAddress: false, autoScanEnabled: true };
  sessionStorage.clear();
});

describe('InboxAddressCard', () => {
  it('shows the address of the entity and says documents are read on arrival', () => {
    renderWithProviders(<InboxAddressCard />);

    expect(screen.getByTestId('inbox-email')).toHaveTextContent('books@acme.weldsuite.org');
    expect(screen.getByText('Documents are read as soon as they arrive.')).toBeInTheDocument();
  });

  it('says reading is off when the entity has it off, and when the address is the workspace one', () => {
    env.inbox = { entityId: 'ent_1', email: 'books@acme.weldsuite.org', workspaceAddress: true, autoScanEnabled: false };
    renderWithProviders(<InboxAddressCard />);

    expect(screen.getByText(/This is the address of your workspace/)).toBeInTheDocument();
    expect(screen.getByText(/Automatic reading is off/)).toBeInTheDocument();
  });

  it('copies the address, names it on the button and confirms in a live region', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderWithProviders(<InboxAddressCard />);

    await user.click(screen.getByRole('button', { name: 'Copy address: books@acme.weldsuite.org' }));

    expect(writeText).toHaveBeenCalledWith('books@acme.weldsuite.org');
    await waitFor(() => expect(screen.getByTestId('copy-feedback')).toHaveTextContent('Copied'));
    expect(screen.getByTestId('copy-feedback')).toHaveAttribute('role', 'status');
  });

  it('says when copying fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderWithProviders(<InboxAddressCard />);

    await user.click(screen.getByRole('button', { name: /Copy address/ }));

    await waitFor(() => expect(screen.getByTestId('copy-feedback')).toHaveTextContent('Copy failed'));
  });

  it('offers to set up an address through Settings, and remembers this page for the way back', async () => {
    const user = userEvent.setup();
    env.inbox = { entityId: 'ent_1', email: null, workspaceAddress: false, autoScanEnabled: false };
    renderWithProviders(<InboxAddressCard />);

    expect(screen.getByText('No inbox address yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy address/ })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Set up the address' });
    expect(link.getAttribute('href')).toMatch(/^\/settings\/entities\/ent_1\/edit/);

    await user.click(link);
    expect(sessionStorage.getItem('settings-return-url')).toBe(window.location.pathname);
  });

  it('does not offer the Settings link to someone who cannot change it', () => {
    env.canManage = false;
    env.inbox = { entityId: 'ent_1', email: null, workspaceAddress: false, autoScanEnabled: false };
    renderWithProviders(<InboxAddressCard />);
    expect(screen.queryByRole('link', { name: 'Set up the address' })).not.toBeInTheDocument();
  });

  it('shows nothing while loading, on an error or without an entity', () => {
    env.isPending = true;
    const { unmount } = renderWithProviders(<InboxAddressCard />);
    expect(screen.queryByTestId('inbox-address')).not.toBeInTheDocument();
    unmount();

    env.isPending = false;
    env.isError = true;
    const second = renderWithProviders(<InboxAddressCard />);
    expect(screen.queryByTestId('inbox-address')).not.toBeInTheDocument();
    second.unmount();

    env.isError = false;
    env.entityId = null;
    renderWithProviders(<InboxAddressCard />);
    expect(screen.queryByTestId('inbox-address')).not.toBeInTheDocument();
  });
});
