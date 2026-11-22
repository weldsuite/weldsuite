import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Buyer } from '@/hooks/queries/use-commerce-buyers-queries';

const env = vi.hoisted(() => ({
  invite: vi.fn(),
  update: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  defaultCurrency: 'EUR' as string | undefined,
}));

vi.mock('sonner', () => ({ toast: { success: env.success, error: env.error } }));
vi.mock('@/hooks/queries/use-commerce-buyers-queries', () => ({
  useInviteCommerceBuyer: () => ({ mutateAsync: env.invite }),
  useUpdateCommerceBuyer: () => ({ mutateAsync: env.update }),
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceSettings: () => ({ data: env.defaultCurrency ? { data: { defaultCurrency: env.defaultCurrency } } : undefined }),
}));

import { EditBuyerDialog, InviteBuyerDialog } from './company-buyer-dialogs';

const buyer = (over: Partial<Buyer> = {}): Buyer => ({
  id: 'byr_1',
  personId: 'per_1',
  companyId: 'cmp_1',
  name: 'Jan de Vries',
  email: 'jan@acme.test',
  role: 'buyer',
  spendLimit: '1500.00',
  spendLimitCurrency: 'EUR',
  status: 'active',
  invitedAt: null,
  acceptedAt: '2026-11-02T10:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  for (const fn of [env.invite, env.update, env.success, env.error]) fn.mockReset();
  env.invite.mockResolvedValue({ data: buyer() });
  env.update.mockResolvedValue({ data: buyer() });
  env.defaultCurrency = 'EUR';
});

describe('InviteBuyerDialog', () => {
  function setup() {
    const onOpenChange = vi.fn();
    render(<InviteBuyerDialog companyId="cmp_1" companyName="Acme BV" open onOpenChange={onOpenChange} />);
    return { onOpenChange, user: userEvent.setup() };
  }

  it('names the company, starts as a buyer with the invitation switched on', () => {
    setup();
    expect(screen.getByText('Add a person to Acme BV. They sign in with their email address.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Buyer/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Send the invitation now' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Currency') as HTMLInputElement).value).toBe('EUR');
  });

  it('asks for the email with the right keyboard and no autofill of somebody else’s address', () => {
    setup();
    const email = screen.getByLabelText('Email address') as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('off');
    expect(email.getAttribute('inputmode')).toBe('email');
    expect((screen.getByLabelText('Spend limit per order') as HTMLInputElement).getAttribute('inputmode')).toBe('decimal');
  });

  it('starts the currency from the workspace default, else EUR', () => {
    env.defaultCurrency = 'GBP';
    setup();
    expect((screen.getByLabelText('Currency') as HTMLInputElement).value).toBe('GBP');
  });

  it('shows the errors in words and sends nothing for an empty email and a bad limit', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Spend limit per order'), 'lots');
    await user.click(screen.getByRole('button', { name: 'Invite buyer' }));
    expect(await screen.findByText('Enter an email address.')).toBeTruthy();
    expect(screen.getByText('Enter an amount such as 1500 or 1500.50.')).toBeTruthy();
    expect(env.invite).not.toHaveBeenCalled();
  });

  it('invites with the role, the limit and the invitation, then says so and closes', async () => {
    const { user, onOpenChange } = setup();
    await user.type(screen.getByLabelText('Email address'), 'sam@acme.test');
    await user.type(screen.getByLabelText('First name'), 'Sam');
    await user.click(screen.getByRole('radio', { name: /^Approver/ }));
    await user.type(screen.getByLabelText('Spend limit per order'), '2500');
    await user.click(screen.getByRole('button', { name: 'Invite buyer' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(env.invite).toHaveBeenCalledWith({
      companyId: 'cmp_1',
      email: 'sam@acme.test',
      firstName: 'Sam',
      role: 'approver',
      spendLimit: '2500.00',
      spendLimitCurrency: 'EUR',
      sendInvite: true,
    });
    expect(env.success).toHaveBeenCalledWith('Invitation sent to sam@acme.test');
  });

  it('adds without an email when the switch is off, and says that instead', async () => {
    const { user, onOpenChange } = setup();
    await user.type(screen.getByLabelText('Email address'), 'sam@acme.test');
    await user.click(screen.getByRole('switch', { name: 'Send the invitation now' }));
    await user.click(screen.getByRole('button', { name: 'Invite buyer' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(env.invite).toHaveBeenCalledWith(expect.objectContaining({ sendInvite: false }));
    expect(env.success).toHaveBeenCalledWith('sam@acme.test added as a buyer');
  });

  it('keeps the dialog open and reports the failure', async () => {
    env.invite.mockRejectedValue(new Error('Person already a buyer'));
    const { user, onOpenChange } = setup();
    await user.type(screen.getByLabelText('Email address'), 'sam@acme.test');
    await user.click(screen.getByRole('button', { name: 'Invite buyer' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith('Person already a buyer'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('cancels without sending', async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(env.invite).not.toHaveBeenCalled();
  });
});

describe('EditBuyerDialog', () => {
  function setup(over: Partial<Buyer> = {}) {
    const onOpenChange = vi.fn();
    render(<EditBuyerDialog buyer={buyer(over)} open onOpenChange={onOpenChange} />);
    return { onOpenChange, user: userEvent.setup() };
  }

  it('starts from the buyer', () => {
    setup({ role: 'admin' });
    expect(screen.getByText('Edit Jan de Vries')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Admin/ }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Spend limit per order') as HTMLInputElement).value).toBe('1500.00');
    expect(screen.getByRole('switch', { name: 'Disabled' }).getAttribute('aria-checked')).toBe('false');
  });

  it('closes without a request when nothing changed', async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(env.update).not.toHaveBeenCalled();
  });

  it('sends only the changed role', async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole('radio', { name: /^Admin/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(env.update).toHaveBeenCalledWith({ id: 'byr_1', data: { role: 'admin' } });
    expect(env.success).toHaveBeenCalledWith('Buyer updated');
  });

  it('clears the limit with nulls and disables the buyer', async () => {
    const { user } = setup();
    await user.clear(screen.getByLabelText('Spend limit per order'));
    await user.click(screen.getByRole('switch', { name: 'Disabled' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update).toHaveBeenCalledWith({
      id: 'byr_1',
      data: { spendLimit: null, spendLimitCurrency: null, status: 'disabled' },
    });
  });

  it('refuses a limit of zero', async () => {
    const { user } = setup();
    await user.clear(screen.getByLabelText('Spend limit per order'));
    await user.type(screen.getByLabelText('Spend limit per order'), '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The amount must be more than zero.')).toBeTruthy();
    expect(env.update).not.toHaveBeenCalled();
  });

  it('reports LAST_ADMIN in words when demoting the last admin', async () => {
    env.update.mockRejectedValue({ status: 409, body: { error: { code: 'LAST_ADMIN', message: 'raw' } } });
    const { user, onOpenChange } = setup({ role: 'admin' });
    await user.click(screen.getByRole('radio', { name: /^Buyer/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith(expect.stringContaining('last admin')));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
