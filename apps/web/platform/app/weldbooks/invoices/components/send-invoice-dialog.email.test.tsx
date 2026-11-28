import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  missing: [] as string[],
  emailInvoice: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/lib/api/domains/weldbooks-sales', () => ({ salesApi: { emailInvoice: env.emailInvoice } }));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink };
});
vi.mock('@/lib/weldbooks/use-entity-invoice-details', () => ({
  useEntityInvoiceDetails: () => ({
    entity: { id: 'ent_1', name: 'Acme B.V.', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    missing: env.missing,
    labels: { vatNumber: 'VAT number', registrationNumber: 'KvK number', iban: 'IBAN', bic: 'BIC', address: 'Business address' },
    isLoading: false,
  }),
}));

import { SendInvoiceDialog } from './send-invoice-dialog';
import { renderWithProviders } from './test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

function renderDialog(props: { isDraft?: boolean; creditNote?: boolean } = {}) {
  return renderWithProviders(
    <SendInvoiceDialog
      invoiceId="inv_1"
      invoiceNumber="F-1"
      contactEmail="klant@example.test"
      isDraft={props.isDraft ?? false}
      creditNote={props.creditNote}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe('SendInvoiceDialog where the edition e-mails invoices', () => {
  beforeEach(() => {
    env.missing = [];
    env.emailInvoice.mockReset();
    env.toast.error.mockReset();
  });
  afterEach(() => setRuntimeConfig(null));

  it('opens the e-mail dialog, with the contact in To, and no "Mark as sent"', () => {
    setRuntimeConfig(RUST);
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Send invoice' })).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveValue('klant@example.test');
    expect(screen.queryByRole('button', { name: 'Mark as sent' })).not.toBeInTheDocument();
  });

  it('e-mails the invoice and shows the link it went with', async () => {
    const user = userEvent.setup();
    setRuntimeConfig(RUST);
    env.emailInvoice.mockResolvedValue({
      data: { id: 'inv_1', delivery: { messageId: 'm', to: ['klant@example.test'], subject: 'Factuur F-1', link: 'https://pay.example.test/d/xyz' } },
    });
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(env.emailInvoice).toHaveBeenCalledWith('inv_1', { to: ['klant@example.test'], attachPdf: true, includeLink: true }),
    );
    expect(await screen.findByLabelText('Online link')).toHaveValue('https://pay.example.test/d/xyz');
  });

  it('uses the credit note title and says a draft is finalized first', () => {
    setRuntimeConfig(RUST);
    renderDialog({ creditNote: true, isDraft: true });
    expect(screen.getByRole('heading', { name: 'Send credit note' })).toBeInTheDocument();
    expect(screen.getByText(/finalized and posted to the ledger before it is sent/)).toBeInTheDocument();
  });

  it('holds a draft back until the company details are filled in', () => {
    setRuntimeConfig(RUST);
    env.missing = ['iban'];
    renderDialog({ isDraft: true });
    expect(screen.getByTestId('entity-invoice-details-notice')).toHaveTextContent('IBAN');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
