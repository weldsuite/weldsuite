import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  salesApi: { createQuote: vi.fn(), updateQuote: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: env.salesApi,
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: env.push }) };
});
vi.mock('@/hooks/queries/use-accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-accounting-queries')>()),
  useAccountingTaxRates: () => ({
    data: {
      data: [
        { id: 'tr_21', name: 'BTW 21%', rate: '21', type: 'sales', isDefault: true, isActive: true },
        { id: 'tr_0', name: 'BTW 0%', rate: '0', type: 'sales', isDefault: false, isActive: true },
        { id: 'tr_in', name: 'Inkoop', rate: '9', type: 'purchase', isDefault: false, isActive: true },
      ],
    },
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => `d:${value}`,
    today: () => '2026-11-28',
  }),
}));
// A plain select stands in for the server-searched contact picker (it has its own tests).
vi.mock('@/components/accounting/contact-picker', () => ({
  ContactPicker: ({ id, value, onChange, invalid }: { id: string; value: string; onChange: (id: string) => void; invalid?: boolean }) => (
    <select id={id} value={value} aria-invalid={invalid} onChange={(event) => onChange(event.target.value)}>
      <option value="">Select a customer</option>
      <option value="c_1">Jansen Bouw</option>
    </select>
  ),
}));
vi.mock('../../invoices/components/product-picker', () => ({
  ProductPicker: ({ onSelect }: { onSelect: (product: { id: string; name: string; price: number } | null) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'p_1', name: 'Hosting', price: 25 })}>
      Pick product
    </button>
  ),
}));

import { QuoteForm } from './quote-form';
import { renderWithProviders } from '../../invoices/components/test-utils';
import type { QuoteDetail } from '@/lib/api/domains/weldbooks-sales';

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Customer'), 'c_1');
  await user.type(screen.getByLabelText('Name of the quote'), 'Nieuwe website');
  await user.type(screen.getByLabelText('Description'), 'Ontwerp');
  await user.clear(screen.getByLabelText('Unit price'));
  await user.type(screen.getByLabelText('Unit price'), '100');
}

describe('QuoteForm', () => {
  beforeEach(() => {
    env.push.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.salesApi.createQuote.mockReset();
    env.salesApi.updateQuote.mockReset();
  });

  it('starts a new quote valid for 30 days, with one line at the default tax rate', () => {
    renderWithProviders(<QuoteForm mode="add" />);
    expect(screen.getByRole('heading', { level: 1, name: 'New quote' })).toBeInTheDocument();
    expect(screen.getByLabelText('Valid from')).toHaveValue('2026-11-28');
    expect(screen.getByLabelText('Valid until')).toHaveValue('2026-12-28');
    expect(screen.getAllByText(/Item 1/)).toHaveLength(1);
    // Only sales rates are offered, never a purchase rate.
    expect(screen.queryByRole('option', { name: /Inkoop/ })).not.toBeInTheDocument();
  });

  it('says what is missing, does not save, and puts the focus on the first problem', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuoteForm mode="add" />);
    await user.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(await screen.findByText('Choose the customer this quote is for.')).toBeInTheDocument();
    expect(screen.getByText('Give the quote a name.')).toBeInTheDocument();
    expect(screen.getByText('Describe this line.')).toBeInTheDocument();
    expect(screen.getByText('Enter a number, zero or more.')).toBeInTheDocument();
    expect(env.salesApi.createQuote).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Customer')).toHaveFocus();
  });

  it('refuses a discount above 100', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuoteForm mode="add" />);
    await fillBasics(user);
    await user.type(screen.getByLabelText('Discount %'), '150');
    await user.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(await screen.findByText('Enter a discount between 0 and 100.')).toBeInTheDocument();
    expect(env.salesApi.createQuote).not.toHaveBeenCalled();
  });

  it('adds up the lines as you type: price times quantity, less the discount, plus tax at the line’s rate', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuoteForm mode="add" />);
    await fillBasics(user);
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '2');
    await user.type(screen.getByLabelText('Discount %'), '10');
    // 2 x 100 less 10% = 180, plus 21% = 217.80
    const preview = screen.getByTestId('quote-preview');
    expect(within(preview).getByText('€217.80')).toBeInTheDocument();
    expect(screen.getAllByText('€180.00').length).toBeGreaterThan(0);
  });

  it('creates the quote and opens it in its panel on the list', async () => {
    const user = userEvent.setup();
    env.salesApi.createQuote.mockResolvedValue({ data: { id: 'q_new' } });
    renderWithProviders(<QuoteForm mode="add" />);
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Create quote' }));
    await waitFor(() => expect(env.salesApi.createQuote).toHaveBeenCalledTimes(1));
    expect(env.salesApi.createQuote).toHaveBeenCalledWith({
      contactId: 'c_1',
      name: 'Nieuwe website',
      validFrom: '2026-11-28',
      validUntil: '2026-12-28',
      lines: [{ description: 'Ontwerp', quantity: 1, unitPrice: 100, taxRateId: 'tr_21', taxRate: 21 }],
    });
    await waitFor(() => expect(env.push).toHaveBeenCalledWith('/weldbooks/quotes?stack=quote:q_new'));
  });

  it('fills a line from a product and keeps what was already typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuoteForm mode="add" />);
    await user.type(screen.getByLabelText('Description'), 'Mijn tekst');
    await user.click(screen.getByRole('button', { name: 'Pick product' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Mijn tekst');
    expect(screen.getByLabelText('Unit price')).toHaveValue('25');
  });

  it('adds and removes lines', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuoteForm mode="add" />);
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getAllByText(/^Item \d$/)).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Remove line' })[0]);
    expect(screen.getAllByText(/^Item \d$/)).toHaveLength(1);
    // The last line cannot be removed: a quote has at least one.
    expect(screen.queryByRole('button', { name: 'Remove line' })).not.toBeInTheDocument();
  });

  describe('editing', () => {
    const quote = {
      id: 'q_1',
      quoteNumber: 'OFF-12',
      name: 'Nieuwe website',
      contactId: 'c_1',
      contactName: 'Jansen Bouw',
      currency: 'EUR',
      status: 'sent',
      validFrom: '2026-11-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
      notes: 'Let op',
      paymentTerms: '14 dagen',
      termsAndConditions: null,
      lines: [{ id: 'l1', description: 'Ontwerp', quantity: '2', unitPrice: '300.00', discountPercent: '10.00', taxRateId: 'tr_0' }],
      invoices: [],
    } as unknown as QuoteDetail;

    it('starts from the quote and saves it with its currency', async () => {
      const user = userEvent.setup();
      env.salesApi.updateQuote.mockResolvedValue({ data: { id: 'q_1' } });
      renderWithProviders(<QuoteForm mode="edit" quote={quote} />);
      expect(screen.getByRole('heading', { level: 1, name: 'Edit quote' })).toBeInTheDocument();
      expect(screen.getByLabelText('Name of the quote')).toHaveValue('Nieuwe website');
      expect(screen.getByLabelText('Valid until')).toHaveValue('2026-12-01');
      expect(screen.getByLabelText('Discount %')).toHaveValue('10.00');
      await user.click(screen.getByRole('button', { name: 'Save quote' }));
      await waitFor(() => expect(env.salesApi.updateQuote).toHaveBeenCalledTimes(1));
      expect(env.salesApi.updateQuote).toHaveBeenCalledWith('q_1', {
        contactId: 'c_1',
        name: 'Nieuwe website',
        currency: 'EUR',
        validFrom: '2026-11-01',
        validUntil: '2026-12-01',
        lines: [{ description: 'Ontwerp', quantity: 2, unitPrice: 300, discountPercent: 10, taxRateId: 'tr_0', taxRate: 0 }],
        notes: 'Let op',
        paymentTerms: '14 dagen',
      });
      await waitFor(() => expect(env.push).toHaveBeenCalledWith('/weldbooks/quotes?stack=quote:q_1'));
    });

    it('says an accepted quote can no longer change when the server refuses with 409', async () => {
      const user = userEvent.setup();
      env.salesApi.updateQuote.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
      renderWithProviders(<QuoteForm mode="edit" quote={quote} />);
      await user.click(screen.getByRole('button', { name: 'Save quote' }));
      await waitFor(() =>
        expect(env.toast.error).toHaveBeenCalledWith('The quote could not be saved', { description: 'An accepted quote can no longer be changed.' }),
      );
      expect(env.push).not.toHaveBeenCalled();
    });
  });
});
