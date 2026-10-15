import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { FONT_METRICS } from '@weldsuite/books-domain/invoice-template/fonts';
import { invoiceFontUrls } from '../../services/invoice-fonts';
import { publicInvoiceFontsRoutes } from './index';

const app = new Hono().route('/public/invoice-fonts', publicInvoiceFontsRoutes);

describe('/public/invoice-fonts', () => {
  it('serves every bundled font to any origin, cached for a year', async () => {
    for (const { file } of Object.values(FONT_METRICS)) {
      const res = await app.request(`/public/invoice-fonts/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('font/ttf');
      expect(res.headers.get('Cache-Control')).toContain('immutable');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  });

  it('knows no other files', async () => {
    expect((await app.request('/public/invoice-fonts/OFL.txt')).status).toBe(404);
    expect((await app.request('/public/invoice-fonts/..%2Findex.ts')).status).toBe(404);
  });

  it('builds hashed absolute URLs for the invoice HTML', () => {
    const url = invoiceFontUrls('https://books-api.weldsuite.org')('noto-sans-regular.ttf', 'abc123');
    expect(url).toBe('https://books-api.weldsuite.org/public/invoice-fonts/noto-sans-regular.ttf?v=abc123');
  });
});
