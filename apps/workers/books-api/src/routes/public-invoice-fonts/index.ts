/**
 * The invoice-template fonts: /public/invoice-fonts/:file.
 *
 * The printable invoice HTML (GET /api/invoices/:id/pdf) is laid out with the
 * metrics of these Noto subsets, and its @font-face rules load them from here
 * (services/invoice-fonts), so the reader's browser sets the text exactly
 * where the layout put it. That HTML often has no origin of its own (mobile
 * WebView source, a shared file), hence the open CORS header.
 *
 * No auth: they are public OFL fonts. The URL carries the file's hash, so a
 * response is cached for a year and a new font build gets new URLs.
 */
import { Hono } from 'hono';
import { FONT_METRICS, type FontFaceKey } from '@weldsuite/books-domain/invoice-template/fonts';
import monoBold from '@weldsuite/books-domain/invoice-template/fonts/noto-mono-bold.ttf';
import monoRegular from '@weldsuite/books-domain/invoice-template/fonts/noto-mono-regular.ttf';
import sansBoldItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-bold-italic.ttf';
import sansBold from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-bold.ttf';
import sansItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-italic.ttf';
import sansRegular from '@weldsuite/books-domain/invoice-template/fonts/noto-sans-regular.ttf';
import serifBoldItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-bold-italic.ttf';
import serifBold from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-bold.ttf';
import serifItalic from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-italic.ttf';
import serifRegular from '@weldsuite/books-domain/invoice-template/fonts/noto-serif-regular.ttf';
import type { Env } from '../../types';

const FACES: Record<FontFaceKey, ArrayBuffer> = {
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

const FILES = new Map(Object.entries(FACES).map(([key, bytes]) => [FONT_METRICS[key as FontFaceKey].file, bytes]));

export const publicInvoiceFontsRoutes = new Hono<{ Bindings: Env }>();

publicInvoiceFontsRoutes.get('/:file', (c) => {
  const bytes = FILES.get(c.req.param('file'));
  if (!bytes) return c.notFound();
  return new Response(bytes, {
    headers: {
      'Content-Type': 'font/ttf',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
