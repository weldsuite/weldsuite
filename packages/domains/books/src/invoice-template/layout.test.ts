import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { contrast } from './colors';
import type { InvoiceDocumentData } from './data';
import { drawableText, textWidth, wrapText } from './fonts';
import { fillPlaceholders, layoutInvoice, type InvoiceLayout } from './layout';
import { renderInvoicePdf } from './pdf';
import { TEMPLATE_PRESETS, presetTemplate } from './presets';
import { PAPER_SIZES, invoiceTemplateDocumentSchema, type InvoiceTemplateDocument } from './schema';
import { renderInvoiceHtmlDocument, renderPageSvg } from './svg';

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

  it('keeps the full body beside a repeating side panel', () => {
    const template = presetTemplate('classic', 'a4');
    const { height } = PAPER_SIZES.a4;
    template.blocks.push(
      { id: 'panel', type: 'rect', x: 0, y: 0, w: 30, h: height, everyPage: true, box: { background: '#eeeeee' } },
      { id: 'side', type: 'text', text: '{{invoiceNumber}}', x: 2, y: 100, w: 26, h: 200, everyPage: true },
    );
    const layout = layoutInvoice(template, data(80));
    const footerTop = template.blocks.find((b) => b.id === 'footer')!.y;
    const rows = (page: number) =>
      layout.pages[page].primitives.filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text' && p.text.startsWith('Consulting')).map((p) => p.y);
    // Neither the panel's height nor the text on it shortens the body: rows run from the top margin to the footer band.
    expect(Math.min(...rows(1))).toBeLessThan(template.margins.top + 40);
    expect(Math.max(...rows(1))).toBeGreaterThan(footerTop - 60);
    expect(Math.max(...rows(1))).toBeLessThan(footerTop);
  });

  it('keeps the balance row readable with a pale accent', () => {
    const template = presetTemplate('classic', 'a4');
    template.theme.accent = '#f2c94c';
    const totals = [...data().totals, { label: 'Paid', value: '€500,00' }, { label: 'Balance due', value: '€710,00', kind: 'balance' as const }];
    const layout = layoutInvoice(template, data(3, { totals }));
    const balance = layout.pages[0].primitives.find((p) => p.kind === 'text' && p.text === 'Balance due');
    expect(balance?.kind === 'text' && contrast(balance.color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('does not grow an empty block by its padding', () => {
    const template = presetTemplate('classic', 'a4');
    template.blocks = template.blocks.map((b) => (b.id === 'shipTo' ? { ...b, h: 4, box: { padding: 12, background: '#f3f4f6' } } : b));
    const layout = layoutInvoice(template, data(3));
    const shipTo = layout.placements.find((p) => p.id === 'shipTo')!;
    expect(shipTo.grew).toBe(false);
    expect(layout.placements.find((p) => p.id === 'items')!.moved).toBe(false);
  });

  it('leaves out a line whose placeholders print nothing, and the separator next to an empty value', () => {
    const fields = { ...data().fields, sellerEmail: 'hello@weld.example', sellerPhone: '', sellerWebsite: 'weld.example' };
    const fill = (text: string) => fillPlaceholders(text, data(1, { fields }));
    expect(fill('{{sellerEmail}}\n{{sellerPhone}}\n{{sellerWebsite}}')).toBe('hello@weld.example\nweld.example');
    expect(fill('Tel. {{sellerPhone}}\nE-mail {{sellerEmail}}')).toBe('E-mail hello@weld.example');
    expect(fill('{{sellerEmail}} · {{sellerPhone}} · {{sellerWebsite}}')).toBe('hello@weld.example · weld.example');
    expect(fill('{{sellerPhone}} · {{sellerWebsite}}')).toBe('weld.example');
    // Typed text, blank lines and unknown placeholders stay as written.
    expect(fill('Thanks!\n\n{{unknown}} {{sellerEmail}}')).toBe('Thanks!\n\n{{unknown}} hello@weld.example');
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

  it('keeps every character for the HTML and replaces the ones the PDF fonts cannot draw', () => {
    expect(wrapText('Łódź ₹', 9, { font: 'helvetica' }, 500)).toEqual(['Łódź ₹']);
    expect(drawableText('Łódź ₹')).toBe('?ód? ?');
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

  it('draws a PDF with one page per layout page', async () => {
    const layout = layoutInvoice(presetTemplate('modern', 'a4'), data(80));
    const bytes = await renderInvoicePdf(layout, { loadImage: async () => null });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(layout.pages.length);
  });
});
