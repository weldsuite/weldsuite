import {
  calculateTotals,
  createEmptyLineItem,
  lineItemTaxMode,
  lineTotal,
  toLineItemInputs,
  validLineItems,
  type LineItemDraft,
} from '@/lib/line-items';
import { toApiItems } from '@/services/api';

function draft(patch: Partial<LineItemDraft> = {}): LineItemDraft {
  return { ...createEmptyLineItem({ taxRate: '21' }), description: 'Item', unitPrice: '100', ...patch };
}

describe('createEmptyLineItem', () => {
  it('starts on the jurisdiction default rate and the general tax code', () => {
    const item = createEmptyLineItem({ taxRate: '18' });

    expect(item).toMatchObject({
      description: '',
      quantity: '1',
      unitPrice: '',
      taxRate: '18',
      taxCode: 'general',
      accrueUseTax: false,
    });
  });

  it('is untaxed when no default is given, rather than assuming 21%', () => {
    expect(createEmptyLineItem().taxRate).toBe('0');
  });

  it('gives every line its own key', () => {
    expect(createEmptyLineItem().key).not.toBe(createEmptyLineItem().key);
  });
});

describe('lineItemTaxMode', () => {
  it('taxes a US invoice by code, a US bill as cost and everything else by rate', () => {
    expect(lineItemTaxMode(true, 'invoice')).toBe('code');
    expect(lineItemTaxMode(true, 'bill')).toBe('cost');
    expect(lineItemTaxMode(false, 'invoice')).toBe('rate');
    expect(lineItemTaxMode(false, 'bill')).toBe('rate');
  });
});

describe('calculateTotals', () => {
  it('adds VAT on top in rate mode', () => {
    const totals = calculateTotals([draft({ quantity: '2', unitPrice: '50', taxRate: '21' })], 'rate');

    expect(totals.subtotal).toBe(100);
    expect(totals.taxTotal).toBeCloseTo(21, 10);
    expect(totals.total).toBeCloseTo(121, 10);
  });

  it('leaves the tax of a US invoice to the server', () => {
    // A stale percentage on the draft must never reach the totals.
    const totals = calculateTotals([draft({ unitPrice: '100', taxRate: '21' })], 'code');

    expect(totals).toEqual({ subtotal: 100, taxTotal: 0, total: 100 });
  });

  it('adds the sales tax a vendor charged on a US bill to the cost', () => {
    const totals = calculateTotals([draft({ unitPrice: '200', taxRate: '8.25' })], 'cost');

    expect(totals.subtotal).toBe(200);
    expect(totals.taxTotal).toBeCloseTo(16.5, 10);
    expect(totals.total).toBeCloseTo(216.5, 10);
  });

  it('does not count use tax in the total of a bill', () => {
    const totals = calculateTotals([draft({ unitPrice: '1000', taxRate: '0', accrueUseTax: true })], 'cost');

    expect(totals.total).toBe(1000);
  });

  it('reads European and US number formats', () => {
    expect(lineTotal(draft({ quantity: '2', unitPrice: '1.234,50' }))).toBe(2469);
    expect(lineTotal(draft({ quantity: '2', unitPrice: '1,234.50' }))).toBe(2469);
  });

  it('treats an empty or junk field as zero rather than NaN', () => {
    const totals = calculateTotals([draft({ quantity: '', unitPrice: 'abc', taxRate: '' })], 'rate');

    expect(totals).toEqual({ subtotal: 0, taxTotal: 0, total: 0 });
  });
});

describe('validLineItems', () => {
  it('drops lines with no description or no price', () => {
    const items = [draft(), draft({ description: '  ' }), draft({ unitPrice: '' }), draft({ unitPrice: '0' })];

    expect(validLineItems(items)).toHaveLength(1);
  });
});

describe('toLineItemInputs', () => {
  it('sends a US invoice line as a tax code with no rate', () => {
    const inputs = toLineItemInputs([draft({ description: ' Hosting ', quantity: '3', unitPrice: '9.99', taxCode: 'saas' })], 'code');

    expect(inputs).toEqual([
      { description: 'Hosting', quantity: 3, unitPrice: 9.99, taxCode: 'saas', sortOrder: 0 },
    ]);
    expect(inputs[0]).not.toHaveProperty('taxRate');
  });

  it('falls back to the general tax code for a line without one', () => {
    expect(toLineItemInputs([draft({ taxCode: '' })], 'code')[0].taxCode).toBe('general');
  });

  it('sends a VAT line as a rate with no tax code', () => {
    const [input] = toLineItemInputs([draft({ taxRate: '9' })], 'rate');

    expect(input).toMatchObject({ taxRate: 9 });
    expect(input).not.toHaveProperty('taxCode');
    expect(input).not.toHaveProperty('accrueUseTax');
  });

  it('sends a US bill line with the vendor tax as a rate', () => {
    const [input] = toLineItemInputs([draft({ taxRate: '7' })], 'cost');

    expect(input).toMatchObject({ taxRate: 7 });
    expect(input).not.toHaveProperty('accrueUseTax');
    expect(input).not.toHaveProperty('taxCode');
  });

  it('sends the accrual and the code a US bill line accrues use tax under', () => {
    const [input] = toLineItemInputs([draft({ taxRate: '0', accrueUseTax: true, taxCode: 'digital_goods' })], 'cost');

    expect(input).toMatchObject({ taxRate: 0, accrueUseTax: true, taxCode: 'digital_goods' });
  });

  it('numbers the lines in order and skips the invalid ones', () => {
    const inputs = toLineItemInputs([draft({ description: 'a' }), draft({ description: '' }), draft({ description: 'c' })], 'code');

    expect(inputs.map((i) => [i.description, i.sortOrder])).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
  });

  it('is what the API adapter turns into the request body of a US invoice', () => {
    const body = toApiItems(toLineItemInputs([draft({ quantity: '2', unitPrice: '49.5', taxCode: 'clothing' })], 'code'));

    expect(body).toEqual([
      { description: 'Item', quantity: '2', unitPrice: '49.5', taxCode: 'clothing', sortOrder: 0 },
    ]);
  });

  it('is what the API adapter turns into the request body of a Dutch invoice', () => {
    const body = toApiItems(toLineItemInputs([draft({ quantity: '1', unitPrice: '10', taxRate: '21' })], 'rate'));

    expect(body).toEqual([
      { description: 'Item', quantity: '1', unitPrice: '10', taxRate: '21', sortOrder: 0 },
    ]);
  });

  it('is what the API adapter turns into the request body of a US bill that accrues use tax', () => {
    const body = toApiItems(
      toLineItemInputs([draft({ unitPrice: '300', taxRate: '0', accrueUseTax: true, taxCode: 'general' })], 'cost'),
    );

    expect(body).toEqual([
      {
        description: 'Item',
        quantity: '1',
        unitPrice: '300',
        taxRate: '0',
        taxCode: 'general',
        accrueUseTax: true,
        sortOrder: 0,
      },
    ]);
  });
});
