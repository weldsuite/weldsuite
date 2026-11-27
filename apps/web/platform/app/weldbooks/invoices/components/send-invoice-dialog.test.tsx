import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type MutateOptions = { onSuccess?: () => void; onError?: (err: unknown) => void };

const env = vi.hoisted(() => ({
  missing: [] as string[],
  send: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useSendInvoice: () => ({ mutate: env.send, isPending: false }),
  useUpdateAccountingEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink };
});
vi.mock('@/lib/weldbooks/use-entity-invoice-details', () => ({
  useEntityInvoiceDetails: () => ({
    entity: { id: 'ent_1', name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    missing: env.missing,
    labels: { vatNumber: 'VAT number', registrationNumber: 'KvK number', iban: 'IBAN', bic: 'BIC', address: 'Business address' },
    isLoading: false,
  }),
}));

import { SendInvoiceDialog } from './send-invoice-dialog';
import { renderWithProviders } from './test-utils';

function renderDialog(props: { isDraft?: boolean } = {}) {
  return renderWithProviders(
    <SendInvoiceDialog
      invoiceId="inv_1"
      isDraft={props.isDraft ?? true}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe('SendInvoiceDialog', () => {
  beforeEach(() => {
    env.missing = [];
    env.send.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
  });

  it('says nothing is e-mailed, and marks the invoice as sent', async () => {
    const user = userEvent.setup();
    env.send.mockImplementation((_id: string, options: MutateOptions) => options.onSuccess?.());
    renderDialog();

    expect(
      screen.getByText(
        "WeldBooks doesn't e-mail invoices yet. Download the PDF and send it yourself; this marks the invoice as sent.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Send invoice to/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as sent' }));
    expect(env.send).toHaveBeenCalledWith('inv_1', expect.any(Object));
    expect(env.toast.success).toHaveBeenCalledWith('Invoice marked as sent');
  });

  it('holds a draft back until the company details are filled in, and offers to add them', () => {
    env.missing = ['iban'];
    renderDialog();
    expect(screen.getByTestId('entity-invoice-details-notice')).toHaveTextContent('IBAN');
    expect(screen.getByRole('button', { name: 'Add business details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeDisabled();
  });

  it('sends an invoice that is already finalized whatever the company details', () => {
    env.missing = ['iban'];
    renderDialog({ isDraft: false });
    expect(screen.queryByTestId('entity-invoice-details-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeEnabled();
  });

  it("names the details a server refusal lists in the user's language", async () => {
    const user = userEvent.setup();
    const refusal = Object.assign(new Error('Entity is missing legally required invoice fields'), {
      body: { error: { details: { code: 'ENTITY_INVOICE_FIELDS_MISSING', missingFields: ['vatNumber', 'iban'] } } },
    });
    env.send.mockImplementation((_id: string, options: MutateOptions) => options.onError?.(refusal));
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Mark as sent' }));
    expect(env.toast.error).toHaveBeenCalledWith('Could not mark the invoice as sent', {
      description: 'This invoice cannot be finalized or sent until your VAT number, IBAN are filled in.',
    });
  });

  it('shows any other failure as it is', async () => {
    const user = userEvent.setup();
    env.send.mockImplementation((_id: string, options: MutateOptions) => options.onError?.(new Error('Boom')));
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Mark as sent' }));
    expect(env.toast.error).toHaveBeenCalledWith('Could not mark the invoice as sent', { description: 'Boom' });
  });
});
