/**
 * The invoice-template fonts in the browser.
 *
 * The files live in `@weldsuite/books-domain/invoice-template/fonts`; Vite
 * emits each as a content-hashed asset under /assets/ (cached forever) and
 * these imports are only their URLs. Nothing is downloaded until a page draws
 * with a face (the @font-face rules below) or a PDF embeds it
 * (`loadInvoiceFont`), and then only that face.
 */
import { useEffect } from 'react';
import { FONT_METRICS, type FontFaceKey } from '@weldsuite/books-domain/invoice-template/fonts';
import { invoiceFontFaceCss } from '@weldsuite/books-domain/invoice-template/svg';
import monoBold from '@weldsuite/books-domain/invoice-template/fonts/noto-mono-bold.ttf?url';
import monoRegular from '@weldsuite/books-domain/invoice-template/fonts/noto-mono-regular.ttf?url';
import sansBoldItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-bold-italic.ttf?url';
import sansBold from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-bold.ttf?url';
import sansItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-italic.ttf?url';
import sansRegular from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-regular.ttf?url';
import serifBoldItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-bold-italic.ttf?url';
import serifBold from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-bold.ttf?url';
import serifItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-italic.ttf?url';
import serifRegular from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-regular.ttf?url';

const FACE_URLS: Record<FontFaceKey, string> = {
  'sans-regular': sansRegular,
  'sans-bold': sansBold,
  'sans-italic': sansItalic,
  'sans-bold-italic': sansBoldItalic,
  'serif-regular': serifRegular,
  'serif-bold': serifBold,
  'serif-italic': serifItalic,
  'serif-bold-italic': serifBoldItalic,
  'mono-regular': monoRegular,
  'mono-bold': monoBold,
};

const FILE_URLS = new Map(Object.entries(FACE_URLS).map(([key, url]) => [FONT_METRICS[key as FontFaceKey].file, url]));

/** The URL of a bundled font file (a name from `FONT_METRICS`). */
export function invoiceFontUrl(file: string): string {
  const url = FILE_URLS.get(file);
  if (!url) throw new Error(`Unknown invoice font ${file}`);
  return url;
}

const loaded = new Map<string, Promise<ArrayBuffer>>();

/** The bytes of a bundled font file, fetched once per session; the PDF painter's `loadFont`. */
export function loadInvoiceFont(file: string): Promise<ArrayBuffer> {
  let bytes = loaded.get(file);
  if (!bytes) {
    bytes = fetch(invoiceFontUrl(file)).then((res) => {
      if (!res.ok) throw new Error(`Invoice font ${file}: HTTP ${res.status}`);
      return res.arrayBuffer();
    });
    // A failed fetch is retried on the next PDF instead of being remembered.
    bytes.catch(() => loaded.delete(file));
    loaded.set(file, bytes);
  }
  return bytes;
}

const STYLE_ID = 'weldbooks-invoice-fonts';

/** Adds the @font-face rules the invoice SVG pages name, once per document. */
export function ensureInvoiceFontFaces(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = invoiceFontFaceCss(invoiceFontUrl);
  document.head.appendChild(style);
}

/** For components that render invoice pages inline (designer canvas, thumbnails). */
export function useInvoiceFontFaces(): void {
  useEffect(ensureInvoiceFontFaces, []);
}
