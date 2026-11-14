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

/**
 * Fetch an authenticated invoice document as a blob and open it in a new tab.
 * The tab is opened first, inside the click, so the popup blocker allows it;
 * it gets the blob once the document arrived.
 */
export async function openInvoiceDocument(client: ClientApi, url: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const res = await client.getRaw(apiPathOf(url));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (tab) tab.location.href = objectUrl;
    else window.location.href = objectUrl;
    // The tab needs the URL for as long as it renders; release it later.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
