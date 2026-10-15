import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_METRICS } from '@weldsuite/books-domain/invoice-template/fonts';
import { ensureInvoiceFontFaces, invoiceFontUrl, loadInvoiceFont } from './invoice-fonts';

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('weldbooks-invoice-fonts')?.remove();
});

describe('invoice fonts', () => {
  it('has a bundled asset for every face the layout measures', () => {
    for (const { file } of Object.values(FONT_METRICS)) {
      expect(invoiceFontUrl(file)).toMatch(/\.ttf/);
    }
    expect(() => invoiceFontUrl('arial.ttf')).toThrow();
  });

  it('adds the @font-face rules once', () => {
    ensureInvoiceFontFaces();
    ensureInvoiceFontFaces();
    const styles = document.querySelectorAll('#weldbooks-invoice-fonts');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain("font-family:'WeldBooks Noto Sans'");
    expect(styles[0].textContent).toContain(invoiceFontUrl(FONT_METRICS['serif-bold-italic'].file));
  });

  it('fetches a font once and retries after a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    const file = FONT_METRICS['mono-bold'].file;

    await expect(loadInvoiceFont(file)).rejects.toThrow('503');
    const bytes = await loadInvoiceFont(file);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    await loadInvoiceFont(file);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
