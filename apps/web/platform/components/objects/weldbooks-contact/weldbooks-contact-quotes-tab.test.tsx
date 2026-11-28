import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  listQuotes: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: { listQuotes: env.listQuotes },
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: env.open }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: unknown) => `€${value}`,
    formatDate: (value: string | null | undefined) => (value ? `d:${value}` : '—'),
  }),
}));

import { ContactQuotesTab } from './weldbooks-contact-documents-tab';
import { getWeldbooksContactTabs } from './weldbooks-contact-tabs';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const labels = {
  details: 'Details',
  invoices: 'Invoices',
  bills: 'Bills',
  exemptions: 'Exemptions',
  history: 'History',
  quotes: 'Quotes',
  showInvoices: true,
  showBills: false,
  showExemptions: false,
};

describe('the contact panel’s Quotes tab', () => {
  beforeEach(() => {
    env.listQuotes.mockReset();
    env.open.mockReset();
    setRuntimeConfig(RUST);
  });

  it('comes after Invoices, and only where quotes are offered and the contact is a customer', () => {
    const ids = (input: Parameters<typeof getWeldbooksContactTabs>[0]) => getWeldbooksContactTabs(input).map((tab) => tab.id);
    expect(ids({ ...labels, showQuotes: true })).toEqual(['overview', 'invoices', 'quotes', 'history']);
    expect(ids({ ...labels })).toEqual(['overview', 'invoices', 'history']);
    expect(ids({ ...labels, showInvoices: false, showBills: true, showQuotes: false })).toEqual(['overview', 'bills', 'history']);
  });

  it('lists the contact’s quotes, asking the server for that contact only', async () => {
    env.listQuotes.mockResolvedValue({
      data: [
        { id: 'q_1', quoteNumber: 'OFF-1', name: 'Website', total: '1210.00', currency: 'EUR', status: 'sent', validUntil: '2026-12-31', invoiceIds: [] },
        { id: 'q_2', quoteNumber: null, name: 'Onderhoud', total: '300.00', currency: 'EUR', status: 'accepted', validUntil: null, invoiceIds: [] },
      ],
      pagination: { totalCount: 2, hasMore: false },
    });
    renderWithProviders(<ContactQuotesTab contactId="c_1" />);
    expect(await screen.findByText('OFF-1')).toBeInTheDocument();
    expect(screen.getByText('Onderhoud')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('€1210.00')).toBeInTheDocument();
    expect(env.listQuotes).toHaveBeenCalledWith({ contactId: 'c_1', page: 1, pageSize: 25 });
  });

  it('opens a quote as a stacked panel, with a way back to the contact', async () => {
    const user = userEvent.setup();
    env.listQuotes.mockResolvedValue({
      data: [{ id: 'q_1', quoteNumber: 'OFF-1', name: 'Website', total: '1.00', currency: 'EUR', status: 'draft', validUntil: null, invoiceIds: [] }],
      pagination: { totalCount: 1, hasMore: false },
    });
    renderWithProviders(<ContactQuotesTab contactId="c_1" />);
    await user.click(await screen.findByRole('button', { name: 'OFF-1' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'quote', id: 'q_1', stack: true });
  });

  it('says there are none, and when it cannot load', async () => {
    env.listQuotes.mockResolvedValueOnce({ data: [], pagination: { totalCount: 0, hasMore: false } });
    const first = renderWithProviders(<ContactQuotesTab contactId="c_1" />);
    expect(await screen.findByText('No quotes for this customer yet.')).toBeInTheDocument();
    first.unmount();

    env.listQuotes.mockRejectedValue(new Error('down'));
    renderWithProviders(<ContactQuotesTab contactId="c_2" />);
    expect(await screen.findByText('The quotes could not be loaded.')).toBeInTheDocument();
  });
});
