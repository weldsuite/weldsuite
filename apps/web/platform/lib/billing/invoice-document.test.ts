import { describe, expect, it } from 'vitest';
import { apiPathOf, isApiInvoiceUrl } from './invoice-document';

describe('invoice links', () => {
  it('fetches an authenticated API path, and leaves a public link to the browser', () => {
    expect(isApiInvoiceUrl('/api/billing/invoices/inv_1/document')).toBe(true);
    expect(isApiInvoiceUrl('https://pay.stripe.com/invoice/x/pdf')).toBe(false);
  });

  it('hands the client its own path, without the /api prefix it adds itself', () => {
    expect(apiPathOf('/api/billing/invoices/inv_1/document')).toBe('/billing/invoices/inv_1/document');
  });
});
