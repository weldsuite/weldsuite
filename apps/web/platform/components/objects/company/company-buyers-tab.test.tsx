import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Buyer } from '@/hooks/queries/use-commerce-buyers-queries';

const env = vi.hoisted(() => ({
  canUpdate: true,
  buyers: { isPending: false, isError: false, data: { data: [] as unknown[] }, refetch: vi.fn() },
  resend: vi.fn(),
  remove: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => (permission === 'companies:update' ? env.canUpdate : true) }),
}));
vi.mock('sonner', () => ({ toast: { success: env.success, error: env.error } }));
vi.mock('./company-buyer-dialogs', () => ({
  InviteBuyerDialog: ({ companyName }: { companyName: string }) => <div data-testid="invite-dialog">{companyName}</div>,
  EditBuyerDialog: ({ buyer }: { buyer: { email: string } }) => <div data-testid="edit-dialog">{buyer.email}</div>,
}));
vi.mock('./company-approval-threshold', () => ({
  ApprovalThreshold: ({ companyId, canEdit }: { companyId: string; canEdit: boolean }) => (
    <div data-testid="threshold">
      {companyId}:{String(canEdit)}
    </div>
  ),
}));
vi.mock('@/hooks/queries/use-commerce-buyers-queries', () => ({
  useCommerceBuyers: () => env.buyers,
  useResendCommerceBuyerInvite: () => ({ mutateAsync: env.resend }),
  useDeleteCommerceBuyer: () => ({ mutateAsync: env.remove }),
}));

import { CompanyBuyersTab } from './company-buyers-tab';

const buyer = (over: Partial<Buyer> = {}): Buyer => ({
  id: 'byr_1',
  personId: 'per_1',
  companyId: 'cmp_1',
  name: 'Jan de Vries',
  email: 'jan@acme.test',
  role: 'approver',
  spendLimit: '1500.00',
  spendLimitCurrency: 'EUR',
  status: 'active',
  invitedAt: '2026-11-01T10:00:00.000Z',
  acceptedAt: '2026-11-02T10:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  ...over,
});

function give(list: Buyer[]) {
  env.buyers = { isPending: false, isError: false, data: { data: list }, refetch: env.buyers.refetch };
}

function setup() {
  render(<CompanyBuyersTab companyId="cmp_1" companyName="Acme BV" />);
  return userEvent.setup();
}

// Radix menus read pointer capture and scroll into view; jsdom has neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.canUpdate = true;
  env.buyers = { isPending: false, isError: false, data: { data: [] }, refetch: vi.fn() };
  for (const fn of [env.resend, env.remove, env.success, env.error]) fn.mockReset();
  env.resend.mockResolvedValue(undefined);
  env.remove.mockResolvedValue(undefined);
});

describe('CompanyBuyersTab states', () => {
  it('shows a spinner while loading, without the list', () => {
    env.buyers = { ...env.buyers, isPending: true };
    setup();
    expect(screen.queryByText('No buyers yet')).toBeNull();
    expect(screen.getByTestId('threshold')).toBeTruthy();
  });

  it('shows the failure with a retry', async () => {
    env.buyers = { ...env.buyers, isError: true };
    const user = setup();
    expect(screen.getByText('Could not load the buyers.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.buyers.refetch).toHaveBeenCalled();
  });

  it('shows the empty state with an invite action for a member who may update companies', async () => {
    const user = setup();
    expect(screen.getByText('No buyers yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Invite buyer' }));
    expect(screen.getByTestId('invite-dialog').textContent).toBe('Acme BV');
  });

  it('shows the empty state without an invite action when read-only', () => {
    env.canUpdate = false;
    setup();
    expect(screen.getByText('No buyers yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite buyer' })).toBeNull();
  });
});

describe('CompanyBuyersTab list', () => {
  it('shows each buyer with the role, the status, the limit and the dates', () => {
    give([
      buyer(),
      buyer({
        id: 'byr_2',
        name: null,
        email: 'sam@acme.test',
        role: 'buyer',
        spendLimit: null,
        spendLimitCurrency: null,
        status: 'invited',
        acceptedAt: null,
      }),
    ]);
    setup();
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first).getByText('Jan de Vries')).toBeTruthy();
    expect(within(first).getByText('jan@acme.test')).toBeTruthy();
    expect(within(first).getByText('Approver')).toBeTruthy();
    expect(within(first).getByText('Active')).toBeTruthy();
    expect(within(first).getByText(/Up to .*1,500\.00.* per order/)).toBeTruthy();
    expect(within(first).getByText(/Invited .* · Accepted /)).toBeTruthy();
    // No name: the email is the title, and is not repeated.
    expect(within(second).getAllByText('sam@acme.test')).toHaveLength(1);
    expect(within(second).getByText('Invited')).toBeTruthy();
    expect(within(second).getByText('No spend limit')).toBeTruthy();
    expect(within(second).queryByText(/Accepted/)).toBeNull();
  });

  it('gives the threshold the company and whether it may be edited', () => {
    give([buyer()]);
    env.canUpdate = false;
    setup();
    expect(screen.getByTestId('threshold').textContent).toBe('cmp_1:false');
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite buyer' })).toBeNull();
  });

  it('offers Invite buyer next to the list', async () => {
    give([buyer()]);
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Invite buyer' }));
    expect(screen.getByTestId('invite-dialog')).toBeTruthy();
  });
});

describe('CompanyBuyersTab actions', () => {
  it('opens the edit dialog from the row menu', async () => {
    give([buyer()]);
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Jan de Vries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByTestId('edit-dialog').textContent).toBe('jan@acme.test');
  });

  it('offers Resend invitation only to a buyer who is still invited, and sends it', async () => {
    give([buyer({ id: 'byr_9', status: 'invited', acceptedAt: null })]);
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Jan de Vries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resend invitation' }));
    await waitFor(() => expect(env.resend).toHaveBeenCalledWith('byr_9'));
    expect(env.success).toHaveBeenCalledWith('Invitation sent to jan@acme.test');
  });

  it('does not offer Resend invitation to an active buyer', async () => {
    give([buyer()]);
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Jan de Vries' }));
    await screen.findByRole('menuitem', { name: 'Edit' });
    expect(screen.queryByRole('menuitem', { name: 'Resend invitation' })).toBeNull();
  });

  it('removes a buyer only after a confirmation', async () => {
    give([buyer()]);
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Jan de Vries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    expect(await screen.findByText('Remove Jan de Vries?')).toBeTruthy();
    expect(env.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove buyer' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith('byr_1'));
    expect(env.success).toHaveBeenCalledWith('Buyer removed');
  });

  it('says LAST_ADMIN in words and keeps the confirmation up', async () => {
    give([buyer({ role: 'admin' })]);
    env.remove.mockRejectedValue({ status: 409, body: { error: { code: 'LAST_ADMIN', message: 'raw' } } });
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Jan de Vries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(await screen.findByRole('button', { name: 'Remove buyer' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith(expect.stringContaining('last admin')));
    expect(screen.getByText('Remove Jan de Vries?')).toBeTruthy();
  });

  it('reports a failed resend', async () => {
    give([buyer({ status: 'invited', acceptedAt: null })]);
    env.resend.mockRejectedValue(new Error('mail down'));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Jan de Vries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resend invitation' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith('mail down'));
  });
});
