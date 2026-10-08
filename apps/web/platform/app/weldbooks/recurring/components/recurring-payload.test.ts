import { describe, expect, it } from 'vitest';
import { EMPTY_SALES_TAX_LINE } from '@/lib/weldbooks/document-tax-form';
import { buildRecurringPayload, type RecurringFormShape } from './recurring-payload';

function form(overrides: Partial<RecurringFormShape> = {}): RecurringFormShape {
  return {
    name: 'Retainer',
    contactId: 'cus_1',
    frequency: 'monthly',
    nextIssueDate: '2026-04-01',
    endDate: '',
    autoFinalize: true,
    autoSend: false,
    paymentTermsDays: 30,
    reference: '',
    notes: 'Thanks',
    items: [{ ...EMPTY_SALES_TAX_LINE, description: 'Hosting', quantity: 2, unitPrice: 49.5 }],
    ...overrides,
  };
}

describe('buildRecurringPayload', () => {
  it('stores the sales tax settings of each line on a US template, with numbers as the template schema has them', () => {
    const payload = buildRecurringPayload(
      form({
        items: [
          {
            ...EMPTY_SALES_TAX_LINE,
            description: 'Hosting',
            quantity: 2,
            unitPrice: 49.5,
            productId: 'prod_1',
            taxCode: 'saas',
            taxUse: 'business',
            taxIncluded: true,
            classId: 'dim_c1',
          },
        ],
        shipFromDifferent: true,
        shipFromAddress: { city: 'Seattle', state: 'WA', postalCode: '98101' },
      }),
      { mode: 'add', salesTax: true, currency: 'USD' },
    );

    expect(payload).toEqual({
      name: 'Retainer',
      contactId: 'cus_1',
      frequency: 'monthly',
      nextIssueDate: '2026-04-01',
      endDate: undefined,
      autoFinalize: true,
      autoSend: false,
      templateData: {
        items: [
          {
            description: 'Hosting',
            quantity: 2,
            unitPrice: 49.5,
            unit: undefined,
            accountId: null,
            taxRateId: null,
            productId: 'prod_1',
            taxCode: 'saas',
            taxUse: 'business',
            taxIncluded: true,
            classId: 'dim_c1',
            locationId: null,
          },
        ],
        notes: 'Thanks',
        reference: undefined,
        paymentTermsDays: 30,
        currency: 'USD',
        shipFromAddress: { city: 'Seattle', state: 'WA', postalCode: '98101' },
      },
    });
  });

  it('keeps the entity address as the origin unless another one is given', () => {
    const payload = buildRecurringPayload(form(), { mode: 'edit', salesTax: true, currency: 'USD' });
    expect((payload.templateData as { shipFromAddress: unknown }).shipFromAddress).toBeNull();
  });

  it('stores the VAT rate of each line on a Dutch template and no sales tax fields', () => {
    const payload = buildRecurringPayload(
      form({ items: [{ ...EMPTY_SALES_TAX_LINE, description: 'Hosting', quantity: 1, unitPrice: 10, taxRateId: 'tax_21', taxCode: 'saas' }] }),
      { mode: 'add', salesTax: false, currency: 'EUR' },
    );
    const template = payload.templateData as { items: Array<Record<string, unknown>>; shipFromAddress?: unknown };
    expect(template.items[0]).toMatchObject({ taxRateId: 'tax_21' });
    expect(template.items[0]).not.toHaveProperty('taxCode');
    expect(template).not.toHaveProperty('shipFromAddress');
  });

  it('keeps what the form does not show when a template is edited', () => {
    const payload = buildRecurringPayload(form({ notes: '' }), {
      mode: 'edit',
      salesTax: true,
      currency: 'USD',
      existing: { internalNotes: 'Renegotiate in June', revenueAccountId: 'acc_9', notes: 'Old note', currency: 'USD' },
    });
    expect(payload.templateData).toMatchObject({ internalNotes: 'Renegotiate in June', revenueAccountId: 'acc_9' });
    // A note that was cleared in the form is gone, not kept from the old template.
    expect((payload.templateData as { notes?: string }).notes).toBeUndefined();
  });
});
