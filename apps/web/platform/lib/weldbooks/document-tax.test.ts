import { describe, expect, it } from 'vitest';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import {
  buildTaxPreviewRequest,
  exemptCertificateIdsOf,
  exemptNoticeText,
  groupTaxBreakdown,
  hasCompleteOverride,
  hasEngineUnavailableWarning,
  hasProviderSyncWarning,
  taxWarningText,
  type TaxFormLine,
  type TaxPreviewInput,
} from './document-tax';
import { isWeldTaxCode, productTaxCode } from './tax-codes';

const warnings = {
  not_registered_in_state: 'No sales tax: you are not registered to collect it in {state}.',
  address_unverified: 'The address could not be verified.',
};

function line(overrides: Partial<TaxFormLine> = {}): TaxFormLine {
  return { description: 'Consulting', quantity: 2, unitPrice: 100, discountPercent: 0, ...overrides };
}

function input(overrides: Partial<TaxPreviewInput> = {}): TaxPreviewInput {
  return {
    kind: 'invoice',
    salesTax: true,
    contactId: 'cus_1',
    issueDate: '2026-03-01',
    currency: 'USD',
    billingAddress: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    lines: [line()],
    ...overrides,
  };
}

describe('buildTaxPreviewRequest: US invoice', () => {
  it('sends the document context and the sales tax fields of each line', () => {
    const request = buildTaxPreviewRequest(
      input({
        shipFromAddress: { state: 'WA', postalCode: '98101', country: 'US' },
        marketplaceFacilitated: true,
        lines: [
          line({
            productId: 'prod_1',
            taxCode: 'saas',
            taxUse: 'personal',
            taxIncluded: true,
            taxOverrideAmount: '5.5',
            taxOverrideReason: 'Agreed with the state',
          }),
        ],
      }),
    );

    expect(request).toEqual({
      kind: 'invoice',
      contactId: 'cus_1',
      issueDate: '2026-03-01',
      currency: 'USD',
      billingAddress: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      shippingAddress: null,
      shipFromAddress: { state: 'WA', postalCode: '98101', country: 'US' },
      marketplaceFacilitated: true,
      items: [
        {
          description: 'Consulting',
          quantity: '2',
          unitPrice: '100',
          discountPercent: '0',
          productId: 'prod_1',
          taxCode: 'saas',
          taxUse: 'personal',
          taxIncluded: true,
          taxOverrideAmount: '5.5',
          taxOverrideReason: 'Agreed with the state',
        },
      ],
    });
  });

  it('leaves defaults unset: no code, no use, no override', () => {
    const request = buildTaxPreviewRequest(input());
    expect(request?.items[0]).toEqual({
      description: 'Consulting',
      quantity: '2',
      unitPrice: '100',
      discountPercent: '0',
      productId: null,
      taxCode: null,
      taxUse: null,
      taxIncluded: false,
    });
  });

  it('leaves out an override that has an amount but no reason', () => {
    const request = buildTaxPreviewRequest(
      input({ lines: [line({ taxOverrideAmount: '5', taxOverrideReason: '   ' })] }),
    );
    expect(request?.items[0]).not.toHaveProperty('taxOverrideAmount');
    expect(request?.items[0]).not.toHaveProperty('taxOverrideReason');
    expect(hasCompleteOverride({ taxOverrideAmount: '5', taxOverrideReason: ' ' })).toBe(false);
    expect(hasCompleteOverride({ taxOverrideAmount: '0', taxOverrideReason: 'Exempt by statute' })).toBe(true);
  });

  it('sends a ship-to only when the form has one', () => {
    const request = buildTaxPreviewRequest(
      input({ shippingAddress: { line1: '9 Dock Rd', city: 'Seattle', state: 'WA', postalCode: '98101' } }),
    );
    expect(request?.shippingAddress).toEqual({ line1: '9 Dock Rd', city: 'Seattle', state: 'WA', postalCode: '98101' });
  });

  it('has nothing to calculate until a line has a quantity and a price', () => {
    expect(buildTaxPreviewRequest(input({ lines: [line({ unitPrice: 0 })] }))).toBeNull();
    expect(buildTaxPreviewRequest(input({ lines: [line({ quantity: '' })] }))).toBeNull();
    expect(buildTaxPreviewRequest(input({ lines: [line({ unitPrice: 0 }), line({ unitPrice: 5 })] }))).not.toBeNull();
  });
});

describe('buildTaxPreviewRequest: Dutch invoice', () => {
  it('sends the VAT rate of each line and no sales tax fields', () => {
    const request = buildTaxPreviewRequest(
      input({
        salesTax: false,
        currency: 'EUR',
        billingAddress: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
        // Sales tax inputs on a VAT entity's lines (leftovers) never reach the request.
        marketplaceFacilitated: true,
        shipFromAddress: { state: 'WA' },
        lines: [line({ taxRateId: 'tax_21', taxCode: 'saas', taxIncluded: true }), line({ taxRateId: 'none' })],
      }),
    );

    expect(request).toEqual({
      kind: 'invoice',
      contactId: 'cus_1',
      issueDate: '2026-03-01',
      currency: 'EUR',
      billingAddress: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
      shippingAddress: null,
      items: [
        { description: 'Consulting', quantity: '2', unitPrice: '100', discountPercent: '0', taxRateId: 'tax_21' },
        { description: 'Consulting', quantity: '2', unitPrice: '100', discountPercent: '0', taxRateId: null },
      ],
    });
  });
});

describe('buildTaxPreviewRequest: credit memo', () => {
  it('names the credited invoice and each credited line, and sends no tax settings of its own', () => {
    const request = buildTaxPreviewRequest(
      input({
        kind: 'credit_memo',
        originalInvoiceId: 'inv_9',
        lines: [line({ originalLineId: 'ili_1', taxCode: 'saas', taxOverrideAmount: '9', taxOverrideReason: 'x' })],
      }),
    );

    expect(request?.kind).toBe('credit_memo');
    expect(request?.originalInvoiceId).toBe('inv_9');
    expect(request?.items[0]).toEqual({
      description: 'Consulting',
      quantity: '2',
      unitPrice: '100',
      discountPercent: '0',
      originalLineId: 'ili_1',
    });
    expect(request).not.toHaveProperty('marketplaceFacilitated');
  });
});

describe('buildTaxPreviewRequest: US bill', () => {
  it('sends the delivery address, the vendor rate, the tax code and the use tax flag', () => {
    const request = buildTaxPreviewRequest(
      input({
        kind: 'bill',
        deliveryAddress: { line1: '5 Depot Way', city: 'Dallas', state: 'TX', postalCode: '75001' },
        lines: [line({ vendorTaxRate: '8.25', taxCode: 'general', accrueUseTax: true }), line({ accrueUseTax: false })],
      }),
    );

    expect(request?.deliveryAddress).toEqual({ line1: '5 Depot Way', city: 'Dallas', state: 'TX', postalCode: '75001' });
    expect(request?.items[0]).toMatchObject({ taxRate: '8.25', taxCode: 'general', accrueUseTax: true });
    expect(request?.items[1]).toMatchObject({ accrueUseTax: false });
    expect(request?.items[1]).not.toHaveProperty('taxRate');
    expect(request).not.toHaveProperty('marketplaceFacilitated');
  });
});

const row = (overrides: Partial<TaxBreakdownRow>): TaxBreakdownRow => ({
  taxRateName: 'Sales tax',
  taxRate: 0,
  taxableAmount: 0,
  taxAmount: 0,
  ...overrides,
});

describe('groupTaxBreakdown', () => {
  it('sums the lines of one jurisdiction and orders state, county, city', () => {
    const groups = groupTaxBreakdown([
      row({ lineId: 'a', jurisdictionCode: 'CITY', jurisdictionName: 'Austin', jurisdictionLevel: 'city', taxRate: 1, taxableAmount: 100, taxAmount: 1 }),
      row({ lineId: 'a', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 }),
      row({ lineId: 'b', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 50, taxAmount: 3.13 }),
    ]);

    expect(groups.map((g) => [g.name, g.taxableAmount, g.taxAmount])).toEqual([
      ['Texas', 150, 9.38],
      ['Austin', 100, 1],
    ]);
    expect(groups.every((g) => g.isJurisdiction)).toBe(true);
  });

  it('keeps exempt amounts, reasons and certificates, and puts use tax after the sales tax', () => {
    const groups = groupTaxBreakdown([
      row({ jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', kind: 'use', taxRate: 6.25, taxAmount: 5 }),
      row({
        jurisdictionCode: 'WA',
        jurisdictionName: 'Washington',
        jurisdictionLevel: 'state',
        taxRate: 6.5,
        taxableAmount: 0,
        exemptAmount: 200,
        exemptReason: 'resale',
        certificateId: 'cert_1',
      }),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(['tax', 'use']);
    expect(groups[0]).toMatchObject({ exemptAmount: 200, exemptReasons: ['resale'], certificateIds: ['cert_1'] });
  });

  it('leaves VAT rows as they are, in the order the server sent them', () => {
    const groups = groupTaxBreakdown([
      row({ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 }),
      row({ taxRateName: 'BTW 9%', taxRate: 9, taxableAmount: 50, taxAmount: 4.5 }),
    ]);
    expect(groups.map((g) => [g.name, g.taxAmount, g.isJurisdiction])).toEqual([
      ['BTW 21%', 21, false],
      ['BTW 9%', 4.5, false],
    ]);
  });

  it('lists each certificate once', () => {
    expect(
      exemptCertificateIdsOf([row({ certificateId: 'c1' }), row({ certificateId: 'c1' }), row({ certificateId: 'c2' }), row({})]),
    ).toEqual(['c1', 'c2']);
  });
});

describe('tax warnings', () => {
  it('names the state in "not registered"', () => {
    expect(taxWarningText('not_registered_in_state', warnings, { state: 'NY' })).toBe(
      'No sales tax: you are not registered to collect it in NY.',
    );
    expect(taxWarningText('not_registered_in_state', warnings, { stateFallback: 'the ship-to state' })).toBe(
      'No sales tax: you are not registered to collect it in the ship-to state.',
    );
  });

  it('shows an unknown code as readable text, with its detail', () => {
    expect(taxWarningText('some_new_code', warnings)).toBe('some new code');
    expect(taxWarningText('tax_engine_unavailable: timed out', warnings)).toBe('tax engine unavailable: timed out');
  });

  it('recognizes the warnings the detail page acts on', () => {
    expect(hasEngineUnavailableWarning(['tax_engine_unavailable: timed out'])).toBe(true);
    expect(hasEngineUnavailableWarning(['address_unverified'])).toBe(false);
    expect(hasProviderSyncWarning(['commit_failed: 502'])).toBe(true);
    expect(hasProviderSyncWarning(['reverse_failed: x'])).toBe(true);
    expect(hasProviderSyncWarning(['reverse_unsupported: x'])).toBe(false);
  });
});

describe('exemptNoticeText', () => {
  const labels = {
    reason: 'Exempt sale: {reason}.',
    reasonWithCertificate: 'Exempt sale: {reason}. Certificate no. {number}.',
    certificateOnly: 'Exempt sale. Certificate no. {number}.',
    notice: 'Exempt sale.',
  };

  it('names the reason and the certificate number', () => {
    expect(exemptNoticeText(labels, ['resale'], ['A-123'])).toBe('Exempt sale: Resale. Certificate no. A-123.');
  });

  it('falls back to what is known', () => {
    expect(exemptNoticeText(labels, ['non_profit'], [])).toBe('Exempt sale: Non profit.');
    expect(exemptNoticeText(labels, [], ['A-1', 'A-1', 'B-2'])).toBe('Exempt sale. Certificate no. A-1, B-2.');
    expect(exemptNoticeText(labels, [], [])).toBe('Exempt sale.');
  });
});

describe('product tax codes', () => {
  it('uses the product tax class when it is a WeldBooks code', () => {
    expect(productTaxCode({ taxClass: 'saas' })).toBe('saas');
    expect(productTaxCode({ taxClass: 'standard' })).toBeNull();
    expect(productTaxCode({ taxClass: 'clothing', taxable: false })).toBe('non_taxable');
    expect(productTaxCode(null)).toBeNull();
    expect(isWeldTaxCode('shipping')).toBe(true);
    expect(isWeldTaxCode('txcd_10103001')).toBe(false);
  });
});
