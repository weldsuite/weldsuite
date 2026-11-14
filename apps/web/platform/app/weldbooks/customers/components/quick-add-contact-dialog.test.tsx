import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

const create = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({ useCreateAccountingCustomer: () => create }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import { QuickAddContactDialog } from './quick-add-contact-dialog';

function renderDialog(role: 'customer' | 'supplier' = 'customer') {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLanguage="en">
        <QuickAddContactDialog
          open
          onOpenChange={onOpenChange}
          role={role}
          onCreated={onCreated}
          onOpenExisting={vi.fn()}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onCreated, onOpenChange };
}

describe('QuickAddContactDialog', () => {
  beforeEach(() => {
    create.mutateAsync.mockReset().mockResolvedValue({ data: { id: 'acn_new' } });
    navigate.mockReset();
  });
  afterEach(cleanup);

  it('adds a company customer with its name, email and VAT number, and hands back the new id', async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    expect(screen.getByRole('heading', { name: 'Add customer' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Company name/), 'Acme B.V.');
    await user.type(screen.getByLabelText('Email'), 'ap@acme.test');
    await user.type(screen.getByLabelText('VAT number'), 'NL123456789B01');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() =>
      expect(create.mutateAsync).toHaveBeenCalledWith({
        role: 'customer',
        kind: 'company',
        name: 'Acme B.V.',
        companyName: 'Acme B.V.',
        vatNumber: 'NL123456789B01',
        email: 'ap@acme.test',
        phone: undefined,
      }),
    );
    expect(onCreated).toHaveBeenCalledWith('acn_new');
  });

  it('asks for a company name before saving', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(await screen.findByText('Company name is required')).toBeInTheDocument();
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });

  it('adds a person supplier by first and last name', async () => {
    const user = userEvent.setup();
    renderDialog('supplier');

    expect(screen.getByRole('heading', { name: 'Add supplier' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Person/ }));
    await user.type(screen.getByLabelText('First name'), 'Ada');
    await user.type(screen.getByLabelText('Last name'), 'Lovelace');
    await user.click(screen.getByRole('button', { name: 'Create supplier' }));

    await waitFor(() =>
      expect(create.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'supplier', kind: 'person', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' }),
      ),
    );
  });
});

describe('QuickAddContactDialog: more details', () => {
  afterEach(cleanup);

  it('opens the full customer form and closes the popup', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog('customer');

    await user.click(screen.getByRole('button', { name: 'More details…' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/customers/add', search: {} });
  });

  it('opens the same form for a supplier', async () => {
    const user = userEvent.setup();
    renderDialog('supplier');

    await user.click(screen.getByRole('button', { name: 'More details…' }));

    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/customers/add', search: { role: 'supplier' } });
  });
});
