/**
 * Where printable invoice HTML loads the invoice-template fonts from: this
 * worker's own /public/invoice-fonts route (routes/public-invoice-fonts).
 * Absolute, because the HTML is often shown without an origin of its own
 * (mobile WebView source, a shared file). The hash in the query changes with
 * the file, so the font responses can be cached for a year.
 */
import type { FontUrlResolver } from '@weldsuite/books-domain/invoice-template/svg';

export const PUBLIC_INVOICE_FONTS_PATH = '/public/invoice-fonts';

export function invoiceFontUrls(origin: string): FontUrlResolver {
  return (file, hash) => `${origin}${PUBLIC_INVOICE_FONTS_PATH}/${encodeURIComponent(file)}?v=${hash}`;
}
