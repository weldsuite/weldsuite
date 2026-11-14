import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientApi } from '@weldsuite/api-client/types';
import { apiPathOf, isApiInvoiceUrl, openInvoiceDocument, sandboxedInvoicePage } from './invoice-document';

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

/** A blob's text: Node's (from a Response) has `text()`, jsdom's only FileReader. */
function textOf(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

describe('openInvoiceDocument', () => {
  const created: Blob[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:https://app.weldsuite.eu/doc';
    });
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  function clientAnswering(type: string, body: string) {
    const getRaw = vi.fn(async () => new Response(body, { headers: { 'content-type': type } }));
    return { client: { getRaw } as unknown as ClientApi, getRaw };
  }

  it('shows an HTML invoice in the sandboxed page, fetched with the session', async () => {
    const { client, getRaw } = clientAnswering('text/html; charset=utf-8', '<h1>Invoice WS-0001</h1>');
    const tab = { location: { href: '' } } as unknown as Window;
    await openInvoiceDocument(client, '/api/billing/invoices/binv_1/document', tab, 'Invoice');
    expect(getRaw).toHaveBeenCalledWith('/billing/invoices/binv_1/document');
    expect(tab.location.href).toBe('blob:https://app.weldsuite.eu/doc');
    expect(created[0].type).toBe('text/html;charset=utf-8');
    // The URL is released once the tab had time to render it.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://app.weldsuite.eu/doc');
    vi.useRealTimers();
    const page = await textOf(created[0]);
    expect(page).toContain('<iframe sandbox="allow-modals allow-popups"');
    expect(page).toContain('&lt;h1&gt;Invoice WS-0001&lt;/h1&gt;');
  });

  it('shows a PDF as it is', async () => {
    const { client } = clientAnswering('application/pdf', '%PDF-1.7');
    const tab = { location: { href: '' } } as unknown as Window;
    await openInvoiceDocument(client, '/api/billing/invoices/binv_2/document', tab, 'Invoice');
    vi.useRealTimers();
    expect(await textOf(created[0])).toBe('%PDF-1.7');
    expect(tab.location.href).toBe('blob:https://app.weldsuite.eu/doc');
  });
});
