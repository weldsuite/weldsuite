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

function renderDialog(props: { isDraft?: boolean; contactEmail?: string | null } = {}) {
  return renderWithProviders(
    <SendInvoiceDialog
      invoiceId="inv_1"
      contactEmail={props.contactEmail === undefined ? 'billing@globex.test' : props.contactEmail}
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

  it('names the address it sends to and sends', async () => {
    const user = userEvent.setup();
    env.send.mockImplementation((_id: string, options: MutateOptions) => options.onSuccess?.());
    renderDialog();

    expect(screen.getByText('Send invoice to billing@globex.test?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(env.send).toHaveBeenCalledWith('inv_1', expect.any(Object));
    expect(env.toast.success).toHaveBeenCalledWith('Invoice sent');
  });

  it('holds a draft back until the company details are filled in, and offers to add them', () => {
    env.missing = ['iban'];
    renderDialog();
    expect(screen.getByTestId('entity-invoice-details-notice')).toHaveTextContent('IBAN');
    expect(screen.getByRole('button', { name: 'Add business details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends an invoice that is already finalized whatever the company details', () => {
    env.missing = ['iban'];
    renderDialog({ isDraft: false });
    expect(screen.queryByTestId('entity-invoice-details-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it("names the details a server refusal lists in the user's language", async () => {
    const user = userEvent.setup();
    const refusal = Object.assign(new Error('Entity is missing legally required invoice fields'), {
      body: { error: { details: { code: 'ENTITY_INVOICE_FIELDS_MISSING', missingFields: ['vatNumber', 'iban'] } } },
    });
    env.send.mockImplementation((_id: string, options: MutateOptions) => options.onError?.(refusal));
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(env.toast.error).toHaveBeenCalledWith('Could not send the invoice', {
      description: 'This invoice cannot be finalized or sent until your VAT number, IBAN are filled in.',
    });
  });

  it('shows any other failure as it is', async () => {
    const user = userEvent.setup();
    env.send.mockImplementation((_id: string, options: MutateOptions) => options.onError?.(new Error('Boom')));
    renderDialog({ contactEmail: null });

    expect(screen.getByText(/No email address found for this contact/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(env.toast.error).toHaveBeenCalledWith('Could not send the invoice', { description: 'Boom' });
  });
});
