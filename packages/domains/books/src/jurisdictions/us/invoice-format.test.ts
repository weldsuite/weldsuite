import { describe, it, expect } from 'vitest';
import {
  US_DATE_FORMAT,
  US_PAPER,
  US_PAYMENT_TERMS,
  formatExemptSaleNotice,
  formatUsDate,
  formatUsMoney,
  getUsInvoiceRequirements,
  parseUsDate,
  usPaymentTermsText,
} from './invoice-format';

describe('US invoice requirements', () => {
  const requirements = getUsInvoiceRequirements();

  it('uses US wording', () => {
    expect(requirements.labels.invoice).toBe('Invoice');
    expect(requirements.labels.creditNote).toBe('Credit memo');
    expect(requirements.labels.billTo).toBe('Bill to');
    expect(requirements.labels.shipTo).toBe('Ship to');
    expect(requirements.labels.tax).toBe('Sales tax');
    expect(requirements.labels.vatNumberLabel).toBe('EIN');
    expect(requirements.labels.registrationLabel).toBe('State tax ID');
  });

  it('requires nothing by law and recommends printing the EIN', () => {
    expect(requirements.requiredFields).toEqual([]);
    expect(requirements.recommendedFields).toEqual(['einOrSsn']);
    expect(requirements.requiredFooter).toBeUndefined();
  });

  it('formats invoice numbers with padding', () => {
    expect(requirements.defaultPadding).toBe(4);
    expect(requirements.formatInvoiceNumber('INV-', 42, 4)).toBe('INV-0042');
    expect(requirements.formatInvoiceNumber('', 12345, 4)).toBe('12345');
  });

  it('ignores the locale for the labels', () => {
    expect(getUsInvoiceRequirements('es-US').labels).toEqual(requirements.labels);
  });
});

describe('US paper and dates', () => {
  it('is Letter', () => {
    expect(US_PAPER.size).toBe('letter');
    expect(US_PAPER.widthIn * 72).toBe(US_PAPER.widthPt);
    expect(US_PAPER.heightIn * 72).toBe(US_PAPER.heightPt);
    expect(US_DATE_FORMAT).toBe('MM/DD/YYYY');
  });

  it('formats an ISO date as MM/DD/YYYY', () => {
    expect(formatUsDate('2026-10-08')).toBe('10/08/2026');
    expect(formatUsDate('2026-01-05T23:30:00.000Z')).toBe('01/05/2026');
    expect(formatUsDate('')).toBe('');
    expect(formatUsDate(null)).toBe('');
    expect(formatUsDate('whenever')).toBe('whenever');
  });

  it('parses MM/DD/YYYY month first', () => {
    expect(parseUsDate('10/08/2026')).toBe('2026-10-08');
    expect(parseUsDate('1/5/2026')).toBe('2026-01-05');
    // 13 cannot be a month: no silent day-month reading
    expect(parseUsDate('13/01/2026')).toBeNull();
    expect(parseUsDate('02/30/2026')).toBeNull();
    expect(parseUsDate('02/29/2028')).toBe('2028-02-29');
    expect(parseUsDate('02/29/2027')).toBeNull();
    expect(parseUsDate('2026-10-08')).toBeNull();
    expect(parseUsDate('')).toBeNull();
  });

  it('round-trips', () => {
    expect(parseUsDate(formatUsDate('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('US money', () => {
  it('formats dollars', () => {
    expect(formatUsMoney(1234.5)).toBe('$1,234.50');
    expect(formatUsMoney('1234.567')).toBe('$1,234.57');
    expect(formatUsMoney(0)).toBe('$0.00');
    expect(formatUsMoney(-1234.56)).toBe('-$1,234.56');
  });

  it('puts negatives in parentheses for statements', () => {
    expect(formatUsMoney(-1234.56, { parentheses: true })).toBe('($1,234.56)');
    expect(formatUsMoney(1234.56, { parentheses: true })).toBe('$1,234.56');
  });

  it('formats other currencies in the US style', () => {
    expect(formatUsMoney(10, { currency: 'EUR' })).toBe('€10.00');
  });

  it('returns an empty string for a non-number', () => {
    expect(formatUsMoney('abc')).toBe('');
    expect(formatUsMoney(Number.NaN)).toBe('');
  });
});

describe('terms and exemptions', () => {
  it('offers the usual payment terms', () => {
    expect(US_PAYMENT_TERMS.map((t) => t.code)).toEqual([
      'due_on_receipt', 'net_10', 'net_15', 'net_30', 'net_45', 'net_60', 'net_90',
    ]);
    expect(US_PAYMENT_TERMS.find((t) => t.code === 'net_30')?.days).toBe(30);
  });

  it('writes the terms sentence', () => {
    expect(usPaymentTermsText(0)).toBe('Payment is due upon receipt.');
    expect(usPaymentTermsText(30)).toBe('Payment is due within 30 days of the invoice date (Net 30).');
    expect(usPaymentTermsText(Number.NaN)).toBe('Payment is due upon receipt.');
  });

  it('prints the exemption reason and certificate number', () => {
    expect(formatExemptSaleNotice('resale', 'RC-123')).toBe('Exempt sale: Resale. Certificate no. RC-123.');
    expect(formatExemptSaleNotice('nonprofit', ' 99 ')).toBe('Exempt sale: Nonprofit organization. Certificate no. 99.');
    expect(formatExemptSaleNotice('government')).toBe('Exempt sale: Government entity. Exemption certificate on file.');
    expect(formatExemptSaleNotice('something_else', null)).toBe('Exempt sale: Exempt purchaser. Exemption certificate on file.');
  });
});
