import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { InvoiceDocumentData } from './data';
import { FONT_FACE_KEYS, FONT_METRICS, drawableText, faceKeyOf, normalizeText, textWidth, wrapText } from './fonts';
import { layoutInvoice, type InvoiceLayout } from './layout';
import { renderInvoicePdf } from './pdf';
import { TEMPLATE_PRESETS, presetTemplate } from './presets';
import { TEMPLATE_FONTS, invoiceTemplateDocumentSchema, type InvoiceTemplateDocument } from './schema';
import { invoiceFontFaceCss, renderInvoiceHtmlDocument, renderPageSvg } from './svg';

const fontDir = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
const loadFont = (file: string) => readFile(join(fontDir, file));

function data(rows = 3, overrides: Partial<InvoiceDocumentData> = {}): InvoiceDocumentData {
  return {
    fields: {
      title: 'Invoice',
      invoiceNumber: 'INV-0042',
      issueDate: '1 October 2026',
      dueDate: '31 October 2026',
      total: '€1.210,00',
      balanceDue: '€1.210,00',
    },
    fieldLabels: { title: 'Invoice', invoiceNumber: 'Invoice number', issueDate: 'Issue date', dueDate: 'Due date' },
    labels: { from: 'From', billTo: 'Bill to', shipTo: 'Ship to', payment: 'Payment', notes: 'Notes', terms: 'Terms', page: 'Page {page} of {total}' },
    seller: { name: 'Weld BV', lines: ['Keizersgracht 1', '1015 CJ Amsterdam'], taxIdLines: ['VAT number: NL123456789B01'] },
    billTo: { name: 'Acme Industries', lines: ['Main Street 5', '3011 AA Rotterdam'] },
    table: {
      columns: {
        description: { label: 'Description' },
        quantity: { label: 'Qty' },
        unitPrice: { label: 'Unit price' },
        taxRate: { label: 'VAT' },
        amount: { label: 'Amount' },
      },
      rows: Array.from({ length: rows }, (_, i) => ({
        cells: { description: `Consulting hours, week ${i + 1}`, quantity: '10', unitPrice: '€100,00', taxRate: '21%', amount: '€1.000,00' },
      })),
    },
    totals: [
      { label: 'Subtotal', value: '€1.000,00' },
      { label: 'VAT 21%', value: '€210,00' },
      { label: 'Total', value: '€1.210,00', kind: 'total' },
    ],
    payment: { bankLines: ['IBAN: NL91 ABNA 0417 1643 00'], instructions: 'Please pay within 30 days.' },
    legal: { notices: [] },
    ...overrides,
  };
}

const texts = (layout: InvoiceLayout, page = 0) =>
  layout.pages[page].primitives.flatMap((p) => (p.kind === 'text' ? [p.text] : []));

describe('presets', () => {
  it.each(TEMPLATE_PRESETS)('%s is a valid template on A4 and Letter', (preset) => {
    for (const size of ['a4', 'letter'] as const) {
      expect(invoiceTemplateDocumentSchema.safeParse(presetTemplate(preset, size)).success).toBe(true);
    }
  });

  it('rejects a template with two tables', () => {
    const doc = presetTemplate('classic', 'a4');
    const table = doc.blocks.find((b) => b.type === 'lineItems')!;
    const result = invoiceTemplateDocumentSchema.safeParse({ ...doc, blocks: [...doc.blocks, { ...table, id: 'items2' }] });
    expect(result.success).toBe(false);
  });

  it('rejects a hidden line-items table, and still prints the lines of one stored that way', () => {
    const doc = presetTemplate('classic', 'a4');
    const hidden = { ...doc, blocks: doc.blocks.map((b) => (b.type === 'lineItems' ? { ...b, hidden: true } : b)) };
    expect(invoiceTemplateDocumentSchema.safeParse(hidden).success).toBe(false);
    expect(texts(layoutInvoice(hidden, data(1)))).toContain('Consulting hours, week 1');
  });

  it('rejects script URLs as images', () => {
    const doc = presetTemplate('classic', 'a4');
    const result = invoiceTemplateDocumentSchema.safeParse({
      ...doc,
      blocks: [...doc.blocks, { id: 'img', type: 'image', src: 'javascript:alert(1)', x: 0, y: 0, w: 10, h: 10 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('layoutInvoice', () => {
  it('keeps a short invoice on one page where it was designed', () => {
    const template = presetTemplate('classic', 'a4');
    const layout = layoutInvoice(template, data(3));
    expect(layout.pages).toHaveLength(1);
    const totals = layout.placements.find((p) => p.id === 'totals')!;
    const designed = template.blocks.find((b) => b.id === 'totals')!;
    expect(totals.y).toBe(designed.y);
    expect(texts(layout)).toContain('Page 1 of 1');
    expect(texts(layout)).toContain('INV-0042');
  });

  it('splits a long table over pages, repeats its header and moves the blocks under it to the last page', () => {
    const layout = layoutInvoice(presetTemplate('classic', 'a4'), data(80));
    expect(layout.pages.length).toBeGreaterThan(2);
    for (let i = 0; i < layout.pages.length; i++) {
      expect(texts(layout, i)).toContain(`Page ${i + 1} of ${layout.pages.length}`);
    }
    // The header row is on the continuation pages too.
    expect(texts(layout, 1)).toContain('DESCRIPTION');
    const totals = layout.placements.find((p) => p.id === 'totals')!;
    expect(totals.page).toBeGreaterThan(0);
    // No table row runs into the footer band.
    const footerTop = presetTemplate('classic', 'a4').blocks.find((b) => b.id === 'footer')!.y;
    for (const page of layout.pages) {
      for (const p of page.primitives) {
        if (p.kind === 'text' && p.text.startsWith('Consulting')) expect(p.y).toBeLessThan(footerTop);
      }
    }
  });

  it('pushes blocks down when the one above them grows', () => {
    const template = presetTemplate('classic', 'a4');
    const seller = { name: 'Weld BV', lines: Array.from({ length: 14 }, (_, i) => `Address line ${i + 1}`) };
    const layout = layoutInvoice(template, data(3, { seller }));
    const billTo = layout.placements.find((p) => p.id === 'billTo')!;
    const designed = template.blocks.find((b) => b.id === 'billTo')!;
    expect(billTo.y).toBeGreaterThan(designed.y);
    expect(layout.placements.find((p) => p.id === 'seller')!.grew).toBe(true);
  });

  it('adds the columns a jurisdiction requires', () => {
    const d = data(2);
    d.table.columns.hsnSac = { label: 'HSN/SAC', required: true };
    d.table.rows.forEach((r) => (r.cells.hsnSac = '998314'));
    const layout = layoutInvoice(presetTemplate('minimal', 'a4'), d);
    expect(texts(layout)).toContain('998314');
  });

  it('never drops the totals or the legal notices', () => {
    const template: InvoiceTemplateDocument = {
      ...presetTemplate('classic', 'a4'),
      blocks: presetTemplate('classic', 'a4').blocks.filter((b) => b.type !== 'totals' && b.type !== 'legal'),
    };
    const layout = layoutInvoice(template, data(2, { legal: { notices: ['BTW verlegd'] } }));
    const all = layout.pages.flatMap((_, i) => texts(layout, i));
    expect(all).toContain('€1.210,00');
    expect(all).toContain('BTW verlegd');
  });

  it('marks a draft on every page', () => {
    const layout = layoutInvoice(presetTemplate('modern', 'letter'), data(80, { draft: { banner: 'Draft: not a valid invoice', watermark: 'DRAFT' } }));
    for (const page of layout.pages) expect(page.primitives.some((p) => p.kind === 'watermark')).toBe(true);
  });

  it('fills placeholders in text blocks', () => {
    const template = presetTemplate('classic', 'a4');
    template.blocks.push({ id: 't', type: 'text', text: 'Pay {{invoiceNumber}} by {{dueDate}}', x: 48, y: 760, w: 400, h: 12 });
    expect(texts(layoutInvoice(template, data(1)))).toContain('Pay INV-0042 by 31 October 2026');
  });

  it('right-aligns amounts on the column edge', () => {
    const template = presetTemplate('classic', 'a4');
    const table = template.blocks.find((b) => b.type === 'lineItems')!;
    const layout = layoutInvoice(template, data(1));
    const amount = layout.pages[0].primitives.find((p) => p.kind === 'text' && p.text === '€1.000,00' && p.y > table.y && p.y < table.y + 60);
    expect(amount?.kind).toBe('text');
    if (amount?.kind === 'text') {
      const right = amount.x + textWidth(amount.text, amount.size, amount.face);
      expect(Math.abs(right - (table.x + table.w - 4))).toBeLessThan(0.01);
    }
  });
});

describe('fonts', () => {
  it('breaks a word wider than the line', () => {
    const lines = wrapText('NL91ABNA0417164300NL91ABNA0417164300', 9, { font: 'helvetica' }, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 9, { font: 'helvetica' })).toBeLessThanOrEqual(60);
  });

  it('draws Central European, Greek, Cyrillic and currency characters as they are', () => {
    for (const font of TEMPLATE_FONTS) {
      for (const text of ['Łódź ₹', 'Ővári Čapek Śląsk Ștefan', 'Αθήνα Київ Москва', '€ £ ¥ ₺ ₴ ₽ ₿ ₫ ₪ №']) {
        expect(wrapText(text, 9, { font }, 2000)).toEqual([text]);
        expect(drawableText(text, { font, bold: true, italic: true })).toBe(text);
      }
    }
  });

  it('replaces only what the bundled fonts lack (CJK, emoji) in the PDF', () => {
    expect(drawableText('Tokyo 東京 🙂 €', { font: 'helvetica' })).toBe('Tokyo ?? ? €');
    expect(textWidth('東', 10, { font: 'helvetica' })).toBe(textWidth('?', 10, { font: 'helvetica' }));
  });

  it('composes decomposed accents and drops invisible format characters', () => {
    expect(normalizeText('Café co­op​')).toBe('Café coop');
  });

  it('ships fonts whose glyphs survive pdf-lib subsetting (every glyph an even number of bytes)', async () => {
    // fontkit's subsetter writes a short loca (offsets / 2): an odd-length glyph breaks every glyph after it.
    for (const key of FONT_FACE_KEYS) {
      const font = fontkit.create(await loadFont(FONT_METRICS[key].file)) as unknown as { loca: { offsets: number[] } };
      expect(font.loca.offsets.every((offset) => offset % 2 === 0), key).toBe(true);
    }
  });

  it('measures with the widths of the font files that ship', async () => {
    const sample = 'Łódź ₹ 1.234,56 Αθήνα Київ WAVE fi';
    for (const key of FONT_FACE_KEYS) {
      const font = fontkit.create(await loadFont(FONT_METRICS[key].file));
      const expected = Array.from(sample).reduce((sum, ch) => sum + font.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth, 0);
      const [family, ...style] = key.split('-');
      const face = {
        font: (({ sans: 'helvetica', serif: 'times', mono: 'courier' }) as const)[family as 'sans' | 'serif' | 'mono'],
        bold: style.includes('bold'),
        italic: style.includes('italic'),
      };
      expect(faceKeyOf(face)).toBe(key);
      // At 1000pt a width in points is a width in 1/1000 em.
      expect(textWidth(sample, 1000, face)).toBeCloseTo((expected * 1000) / font.unitsPerEm, 6);
    }
  });
});

describe('painters', () => {
  it('escapes text in the SVG', () => {
    const layout = layoutInvoice(presetTemplate('classic', 'a4'), data(1, { notes: '<script>alert(1)</script>' }));
    const svg = renderPageSvg(layout, 0);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(renderInvoiceHtmlDocument(layout, { title: 'INV <1>' })).toContain('<title>INV &lt;1&gt;</title>');
  });

  it('points the HTML at the bundled fonts and turns kerning off', () => {
    const layout = layoutInvoice(presetTemplate('classic', 'a4'), data(1));
    const html = renderInvoiceHtmlDocument(layout, { title: 'INV-1', fontUrl: (file, hash) => `https://fonts.test/${file}?v=${hash}` });
    expect(html).toContain(`src:url("https://fonts.test/noto-sans-regular.ttf?v=${FONT_METRICS['sans-regular'].hash}") format("truetype");font-weight:400;font-style:normal`);
    expect(html).toContain("font-family:'WeldBooks Noto Serif';src:url(\"https://fonts.test/noto-serif-bold-italic.ttf");
    expect(html).toContain('font-kerning:none');
    expect(renderPageSvg(layout, 0)).toContain(`font-family="'WeldBooks Noto Sans', 'Noto Sans'`.replaceAll("'", '&#39;'));
    // A URL can't break out of the <style> element.
    expect(invoiceFontFaceCss(() => '"></style><script>x</script>')).not.toContain('</style>');
  });

  it('draws a PDF with one page per layout page', async () => {
    const layout = layoutInvoice(presetTemplate('modern', 'a4'), data(80));
    const bytes = await renderInvoicePdf(layout, { loadImage: async () => null, loadFont });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(layout.pages.length);
  });

  it('prints Łódź ₹ into the PDF with the embedded font, not as "?"', async () => {
    const layout = layoutInvoice(
      presetTemplate('classic', 'a4'),
      data(1, { billTo: { name: 'Łódź ₹ Spółka', lines: ['Αθήνα', 'Київ'] } }),
    );
    expect(texts(layout)).toContain('Łódź ₹ Spółka');
    const pdf = await PDFDocument.load(await renderInvoicePdf(layout, { loadImage: async () => null, loadFont }));

    // Every embedded font maps its drawn glyphs back to Unicode (ToUnicode CMap): the text is really there.
    const drawn = new Set<number>();
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Subtype'))?.toString() !== '/Type0') continue;
      const toUnicode = pdf.context.lookup(obj.get(PDFName.of('ToUnicode')));
      if (!(toUnicode instanceof PDFRawStream)) throw new Error('font without a ToUnicode map');
      const cmap = inflateSync(toUnicode.contents).toString('latin1');
      for (const m of cmap.matchAll(/<[0-9A-F]+> <([0-9A-F]{4})>/gi)) drawn.add(Number.parseInt(m[1], 16));
    }
    for (const ch of 'Łłóź₹ΑθК') expect(drawn, `U+${ch.codePointAt(0)!.toString(16)}`).toContain(ch.codePointAt(0));
  });
});
