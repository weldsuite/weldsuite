import { describe, expect, it } from 'vitest';
import type { InvoiceDocumentData } from './data';
import { layoutInvoice } from './layout';
import { readingOrder, renderMobileInvoice } from './mobile';
import { TEMPLATE_PRESETS, presetTemplate } from './presets';
import type { InvoiceTemplateDocument, TemplateBlock } from './schema';
import { renderInvoiceHtmlDocument } from './svg';

function data(overrides: Partial<InvoiceDocumentData> = {}): InvoiceDocumentData {
  return {
    fields: { title: 'Invoice', invoiceNumber: 'INV-0042', issueDate: '1 October 2026', dueDate: '31 October 2026', footerText: 'Thanks!' },
    fieldLabels: { invoiceNumber: 'Invoice number', issueDate: 'Issue date', dueDate: 'Due date' },
    labels: { from: 'From', billTo: 'Bill to', shipTo: 'Ship to', payment: 'Payment', notes: 'Notes', terms: 'Terms', page: 'Page {page} of {total}' },
    seller: { name: 'Weld BV', lines: ['Keizersgracht 1'], contactLines: ['hello@weld.example'], taxIdLines: ['VAT number: NL123456789B01'] },
    billTo: { name: 'Acme Industries', lines: ['Main Street 5'], contactLines: ['ap@acme.example'] },
    table: {
      columns: {
        description: { label: 'Description' },
        quantity: { label: 'Qty' },
        unitPrice: { label: 'Unit price' },
        taxRate: { label: 'VAT' },
        amount: { label: 'Amount' },
      },
      rows: [
        { cells: { description: 'Consulting', quantity: '10', unitPrice: '€95,00', taxRate: '21%', amount: '€950,00' }, subLines: ['NCM 1234'] },
        { cells: { description: 'Support plan', quantity: '1', unitPrice: '€180,00', taxRate: '21%', amount: '€180,00' } },
      ],
    },
    totals: [
      { label: 'Subtotal', value: '€1.130,00' },
      { label: 'VAT 21%', value: '€237,30' },
      { label: 'Total', value: '€1.367,30', kind: 'total' },
    ],
    payment: { bankLines: ['IBAN: NL91 ABNA 0417 1643 00'], instructions: 'Please pay within 30 days.' },
    notes: 'Thank you for your business.',
    legal: { notices: [] },
    ...overrides,
  };
}

/** Visible text in order, tags removed. */
const plain = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const block = (b: Partial<TemplateBlock> & Pick<TemplateBlock, 'id' | 'type'>): TemplateBlock => ({ x: 0, y: 0, w: 100, h: 20, ...b }) as TemplateBlock;

describe('renderMobileInvoice', () => {
  it.each(TEMPLATE_PRESETS)('shows everything the %s page prints, in one column', (preset) => {
    const template = presetTemplate(preset, 'a4');
    const html = renderMobileInvoice(template, data());
    const out = plain(html);
    for (const expected of ['INV-0042', 'Weld BV', 'Acme Industries', 'Main Street 5', 'Consulting', '€950,00', 'Support plan', 'Total', '€1.367,30', 'IBAN: NL91 ABNA 0417 1643 00']) {
      expect(out).toContain(expected);
    }
    // The page's order survives: who it is from and for, then the items, then the totals.
    expect(out.indexOf('Acme Industries')).toBeLessThan(out.indexOf('Consulting'));
    expect(out.indexOf('Consulting')).toBeLessThan(out.indexOf('€1.367,30'));
  });

  it('turns line items into rows: description and amount on top, the other columns underneath', () => {
    const html = renderMobileInvoice(presetTemplate('classic', 'a4'), data());
    expect(html).toContain('<div class="wim-item-desc">Consulting</div><div class="wim-item-amount">€950,00</div>');
    expect(html).toContain('Qty 10 · Unit price €95,00 · VAT 21%');
    expect(html).toContain('NCM 1234');
  });

  it('uses the template theme', () => {
    const template = presetTemplate('modern', 'a4', '#ff5500');
    template.theme.font = 'times';
    const html = renderMobileInvoice(template, data());
    expect(html).toContain('Times New Roman');
    expect(html).toContain('#ff5500');
  });

  it('leaves out hidden blocks and paper-only decoration', () => {
    const template = presetTemplate('classic', 'a4');
    template.blocks = template.blocks.map((b) => (b.type === 'notes' ? { ...b, hidden: true } : b));
    template.blocks.push(block({ id: 'pn', type: 'pageNumber' }), block({ id: 'band', type: 'rect', box: { background: '#000000' } }));
    const html = renderMobileInvoice(template, data(), { blockIds: true });
    expect(plain(html)).not.toContain('Thank you for your business.');
    expect(html).not.toContain('Page 1 of 1');
    expect(html).not.toContain('data-block-id="band"');
  });

  it('keeps a coloured header band with the white text on it', () => {
    const template = presetTemplate('modern', 'a4', '#0f766e');
    const html = renderMobileInvoice(template, data({ fields: { ...data().fields, balanceDue: '€1.367,30' } }), { blockIds: true });
    expect(html).toContain('<section class="wim-section wim-band wim-bleed wim-bleed-top" data-block-id="band" style="background:#0f766e">');
    const band = html.slice(html.indexOf('data-block-id="band"'), html.indexOf('data-block-id="billTo"'));
    // Title, number and amount due sit inside the band, white as designed.
    expect(band).toContain('Invoice');
    expect(band).toContain('INV-0042');
    expect(band).toContain('€1.367,30');
    expect(band).toContain('#ffffff');
    // And only there: they are not repeated outside it.
    expect(html.split('INV-0042').length).toBe(2);
  });

  it('shows a field the page repeats in its running footer once', () => {
    const template = presetTemplate('classic', 'a4');
    template.blocks.push(block({ id: 'footerNumber', type: 'field', field: 'invoiceNumber', y: 800, everyPage: true } as Partial<TemplateBlock> & { id: string; type: 'field' }));
    const html = renderMobileInvoice(template, data(), { blockIds: true });
    expect(html.split('INV-0042').length).toBe(2);
    expect(html).not.toContain('data-block-id="footerNumber"');
  });

  it('fills placeholders in text blocks and keeps line breaks', () => {
    const template = presetTemplate('minimal', 'a4');
    template.blocks.push(block({ id: 'greet', type: 'text', y: 900, text: 'Invoice {{invoiceNumber}}\nSee you soon' } as Partial<TemplateBlock> & { id: string; type: 'text' }));
    const html = renderMobileInvoice(template, data());
    expect(html).toContain('Invoice INV-0042<br>See you soon');
  });

  it('still shows totals and legal notices when the template has no block for them', () => {
    const template = presetTemplate('classic', 'a4');
    template.blocks = template.blocks.filter((b) => b.type !== 'totals' && b.type !== 'legal');
    const out = plain(renderMobileInvoice(template, data({ legal: { notices: ['BTW verlegd'] } })));
    expect(out).toContain('€1.367,30');
    expect(out).toContain('BTW verlegd');
  });

  it('marks a draft', () => {
    const html = renderMobileInvoice(presetTemplate('classic', 'a4'), data({ draft: { banner: 'Draft: not a valid invoice', watermark: 'Draft' } }));
    expect(html).toContain('<div class="wim-draft">Draft: not a valid invoice</div>');
  });

  it('escapes what customers and users typed', () => {
    const template = presetTemplate('classic', 'a4');
    template.blocks.push(block({ id: 't', type: 'text', y: 900, text: '<script>alert(1)</script>' } as Partial<TemplateBlock> & { id: string; type: 'text' }));
    const html = renderMobileInvoice(
      template,
      data({
        billTo: { name: '<img src=x onerror=alert(1)>', lines: [] },
        notes: '"><svg onload=alert(1)>',
        logoUrl: 'javascript:alert(1)',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('javascript:');
  });

  it('marks sections with their block for the designer only when asked', () => {
    const template = presetTemplate('classic', 'a4');
    expect(renderMobileInvoice(template, data())).not.toContain('data-block-id');
    const html = renderMobileInvoice(template, data(), { blockIds: true });
    const table = template.blocks.find((b) => b.type === 'lineItems')!;
    expect(html).toContain(`data-block-id="${table.id}"`);
  });
});

describe('readingOrder', () => {
  it('reads rows top to bottom and blocks side by side left to right', () => {
    const blocks = [
      block({ id: 'title', type: 'field', x: 350, y: 40, h: 30 }),
      block({ id: 'logo', type: 'logo', x: 40, y: 44, h: 40 }),
      block({ id: 'billTo', type: 'billTo', x: 40, y: 200 }),
      block({ id: 'dates', type: 'field', x: 350, y: 140 }),
      block({ id: 'footer', type: 'text', x: 40, y: 800 }),
    ];
    expect(readingOrder(blocks).map((b) => b.id)).toEqual(['logo', 'title', 'dates', 'billTo', 'footer']);
  });
});

describe('renderInvoiceHtmlDocument with a mobile layout', () => {
  it('shows the mobile layout on phones and the pages everywhere else and in print', () => {
    const template: InvoiceTemplateDocument = presetTemplate('classic', 'a4');
    const html = renderInvoiceHtmlDocument(layoutInvoice(template, data()), {
      title: 'Invoice INV-0042',
      mobile: renderMobileInvoice(template, data()),
    });
    expect(html).toContain('<body class="has-mobile">');
    expect(html).toContain('<div class="mobile">');
    expect(html).toMatch(/@media screen and \(max-width: 640px\)[\s\S]*body\.has-mobile \.page \{ display: none; \}/);
    expect(html).toMatch(/@media print[\s\S]*\.mobile \{ display: none !important; \}/);
  });

  it('is unchanged without one', () => {
    const template = presetTemplate('classic', 'a4');
    const html = renderInvoiceHtmlDocument(layoutInvoice(template, data()), { title: 'x' });
    expect(html).toContain('<body>');
    expect(html).not.toContain('<div class="mobile">');
  });
});
