import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OrderQuote } from '@/hooks/queries/use-commerce-orders-queries';
import { OrderQuoteSummary, discountProblemText } from './order-quote-summary';

const quote: OrderQuote = {
  currency: 'EUR',
  lines: [],
  subtotal: '100.00',
  discountTotal: '10.00',
  shippingTotal: '5.00',
  taxTotal: '0.00',
  total: '95.00',
  discount: { id: 'dsc_1', code: 'SPRING', type: 'percentage', value: '10' },
  discountProblem: null,
  vatTreatment: 'domestic',
  destinationCountry: 'NL',
  viesUnavailable: false,
  pricesIncludeTax: true,
  vatRelief: '0.00',
  taxLines: [{ rate: '21.00', base: '78.51', amount: '16.49' }],
};

function show(props: Partial<Parameters<typeof OrderQuoteSummary>[0]> = {}) {
  render(<OrderQuoteSummary quote={quote} currency="EUR" isFetching={false} isError={false} hasItems {...props} />);
}

describe('discountProblemText', () => {
  it('words every problem the quote can report', () => {
    for (const problem of [
      'NOT_FOUND',
      'NOT_ACTIVE',
      'NOT_STARTED',
      'EXPIRED',
      'USAGE_LIMIT',
      'CUSTOMER_LIMIT',
      'MINIMUM_SUBTOTAL',
      'MINIMUM_QUANTITY',
      'CURRENCY',
      'NOT_ELIGIBLE',
    ] as const) {
      expect(discountProblemText(problem)?.length, problem).toBeGreaterThan(10);
    }
    expect(discountProblemText('EXPIRED')).toBe('This code has expired.');
  });

  it('is null for no problem, and generic for one this version does not know', () => {
    expect(discountProblemText(null)).toBeNull();
    expect(discountProblemText('NEW_PROBLEM')).toBe('This code cannot be used on this order.');
  });
});

describe('OrderQuoteSummary', () => {
  it('shows the subtotal, discount, shipping and total, and the code that applied', () => {
    show();
    expect(screen.getByText('Subtotal').nextElementSibling?.textContent).toContain('100.00');
    expect(screen.getByText('Discount').nextElementSibling?.textContent).toContain('10.00');
    expect(screen.getByText('Shipping').nextElementSibling?.textContent).toContain('5.00');
    expect(screen.getByText('Total').nextElementSibling?.textContent).toContain('95.00');
    expect(screen.getByText('Code SPRING applied')).toBeTruthy();
    expect(screen.queryByText('Tax')).toBeNull();
  });

  it('says how the VAT was worked out, shows it per rate inside the total, and warns when VIES was down', () => {
    show({ quote: { ...quote, viesUnavailable: true, vatTreatment: 'oss', destinationCountry: 'DE', taxLines: [{ rate: '19.00', base: '10.00', amount: '1.90' }] } });
    expect(screen.getByText(/One-Stop Shop.*rate of DE/)).toBeTruthy();
    expect(screen.getByText('Prices include VAT')).toBeTruthy();
    expect(screen.getByText('Includes VAT 19%').nextElementSibling?.textContent).toContain('1.90');
    expect(screen.getByText(/VIES was unavailable/)).toBeTruthy();
  });

  it('adds the VAT on top for net prices, and shows what a zero-rated sale took off', () => {
    show({ quote: { ...quote, pricesIncludeTax: false, vatRelief: '2.10', taxLines: [{ rate: '21.00', base: '10.00', amount: '2.10' }] } });
    expect(screen.getByText('VAT is added to the prices')).toBeTruthy();
    expect(screen.getByText('VAT 21%').nextElementSibling?.textContent).toContain('2.10');
    expect(screen.getByText('VAT removed from the prices').nextElementSibling?.textContent).toContain('2.10');
  });

  it('leaves out the discount row when nothing is taken off, and shows the VAT when there is some', () => {
    show({ quote: { ...quote, discountTotal: '0.00', taxTotal: '21.00', discount: null, taxLines: [{ rate: '21.00', base: '100.00', amount: '21.00' }] } });
    expect(screen.queryByText('Discount')).toBeNull();
    expect(screen.getByText('Includes VAT 21%').nextElementSibling?.textContent).toContain('21.00');
    expect(screen.queryByText(/applied/)).toBeNull();
  });

  it('asks for an item before there is a total', () => {
    show({ quote: undefined, hasItems: false });
    expect(screen.getByText('Add an item to see the total.')).toBeTruthy();
    expect(screen.queryByText('Subtotal')).toBeNull();
  });

  it('says that the totals are updating, politely', () => {
    show({ isFetching: true });
    expect(screen.getByText('Updating the totals…').getAttribute('role')).toBe('status');
  });

  it('says when the total could not be calculated and there is nothing to show instead', () => {
    show({ quote: undefined, isError: true });
    expect(screen.getByRole('alert').textContent).toBe('Could not calculate the total.');
  });
});
