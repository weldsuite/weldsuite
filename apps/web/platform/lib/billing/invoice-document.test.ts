import { describe, expect, it } from 'vitest';
import { apiPathOf, isApiInvoiceUrl, sandboxedInvoicePage } from './invoice-document';

describe('invoice links', () => {
  it('fetches an authenticated API path, and leaves a public link to the browser', () => {
    expect(isApiInvoiceUrl('/api/billing/invoices/inv_1/document')).toBe(true);
    expect(isApiInvoiceUrl('https://pay.stripe.com/invoice/x/pdf')).toBe(false);
  });

  it('hands the client its own path, without the /api prefix it adds itself', () => {
    expect(apiPathOf('/api/billing/invoices/inv_1/document')).toBe('/billing/invoices/inv_1/document');
  });
});

describe('sandboxedInvoicePage', () => {
  it('shows the invoice in a frame without scripts or the platform origin', () => {
    const page = sandboxedInvoicePage('<p class="x">Acme &amp; Co</p><script>alert(1)</script>', 'Invoice <1>');
    expect(page).toContain('<iframe sandbox="allow-modals allow-popups"');
    expect(page).not.toContain('allow-scripts');
    expect(page).not.toContain('allow-same-origin');
    // The document only exists escaped inside srcdoc: nothing in it runs in the page.
    expect(page).not.toContain('<script>');
    expect(page).toContain('srcdoc="&lt;p class=&quot;x&quot;&gt;Acme &amp;amp; Co&lt;/p&gt;&lt;script&gt;');
    expect(page).toContain('<title>Invoice &lt;1&gt;</title>');
  });
});
