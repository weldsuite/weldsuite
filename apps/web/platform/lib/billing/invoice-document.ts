import type { ClientApi } from '@weldsuite/api-client/types';

/**
 * Invoice links. Stripe's `pdfUrl` is a public hosted link a plain `<a href>`
 * can open. On the Mollie editions it is an authenticated API path
 * (`/api/billing/invoices/<id>/document`, a printable HTML invoice), which a
 * link can't call because the browser doesn't send the bearer token.
 */

/** True for an API path that must be fetched with the session token. */
export function isApiInvoiceUrl(url: string): boolean {
  return url.startsWith('/api/');
}

/** The client's path for an API invoice URL (the client adds the `/api` prefix itself). */
export function apiPathOf(url: string): string {
  return url.replace(/^\/api(?=\/)/, '');
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A page that shows `html` in a sandboxed frame: no scripts and an opaque
 * origin. The server sends the invoice with a `sandbox` CSP; a `blob:` copy
 * on the platform's origin loses that header, so the frame keeps the same
 * guarantee whatever the invoice holds.
 */
export function sandboxedInvoicePage(html: string, title: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>',
    escapeAttribute(title),
    '</title>',
    '<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>',
    '</head><body>',
    '<iframe sandbox="allow-modals allow-popups" referrerpolicy="no-referrer" srcdoc="',
    escapeAttribute(html),
    '"></iframe></body></html>',
  ].join('');
}

/**
 * Fetches an authenticated invoice document and shows it in `tab`, which the
 * click handler opened (inside the click, so a popup blocker allows it). An
 * HTML invoice is shown in a sandboxed frame; a PDF as it is.
 */
export async function openInvoiceDocument(
  client: ClientApi,
  url: string,
  tab: Window,
  title: string,
): Promise<void> {
  const res = await client.getRaw(apiPathOf(url));
  const type = res.headers.get('content-type') ?? '';
  const blob = type.startsWith('application/pdf')
    ? await res.blob()
    : new Blob([sandboxedInvoicePage(await res.text(), title)], { type: 'text/html;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  tab.location.href = objectUrl;
  // The tab needs the URL for as long as it renders; release it later.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
