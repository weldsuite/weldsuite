import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';

vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({ labels: { creditNote: 'Credit note', creditNotes: 'Credit notes' }, features: {} }),
}));

import { InvoiceActionBar } from './invoice-header';
import { getInvoiceCapabilities } from './invoice-capabilities';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };
const sent = { id: 'inv_1', status: 'sent', type: 'invoice', balanceDue: '10.00', total: '10.00' } as unknown as InvoiceWithTax;

function renderBar(onSend = vi.fn()) {
  renderWithProviders(
    <InvoiceActionBar
      caps={getInvoiceCapabilities(sent, true, true)}
      recordLabel="Register payment"
      finalizing={false}
      applyingCredit={false}
      onFinalize={vi.fn()}
      onApplyCredit={vi.fn()}
      onSend={onSend}
      onRecordPayment={vi.fn()}
    />,
  );
  return onSend;
}

describe('the send button of the invoice panel', () => {
  afterEach(() => setRuntimeConfig(null));

  it('says "Send" where the edition e-mails invoices, and opens the send dialog', async () => {
    setRuntimeConfig(RUST);
    const onSend = renderBar();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Mark as sent' })).not.toBeInTheDocument();
  });
});
