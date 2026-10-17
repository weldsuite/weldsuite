import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

const create = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({ useCreateAccountingCustomer: () => create }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

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
  });
  afterEach(cleanup);

  it('adds a company customer with its name, email and VAT number, and hands back the new id', async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    expect(screen.getByRole('heading', { name: 'Add customer' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Company Name/), 'Acme B.V.');
    await user.type(screen.getByLabelText('Email'), 'ap@acme.test');
    await user.type(screen.getByLabelText('VAT number'), 'NL123456789B01');
    await user.click(screen.getByRole('button', { name: 'Create Contact' }));

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

    await user.click(screen.getByRole('button', { name: 'Create Contact' }));

    expect(await screen.findByText('Company name is required')).toBeInTheDocument();
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });

  it('adds a person supplier by first and last name', async () => {
    const user = userEvent.setup();
    renderDialog('supplier');

    expect(screen.getByRole('heading', { name: 'Add supplier' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Person/ }));
    await user.type(screen.getByLabelText('First Name'), 'Ada');
    await user.type(screen.getByLabelText('Last Name'), 'Lovelace');
    await user.click(screen.getByRole('button', { name: 'Create Contact' }));

    await waitFor(() =>
      expect(create.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'supplier', kind: 'person', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' }),
      ),
    );
  });
});
