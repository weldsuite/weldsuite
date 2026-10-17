/**
 * Every preset laid out with realistic invoices: a short one, a long one over several pages, Dutch labels,
 * Letter paper and a pale accent. Measures what a reader would notice: text over text, text off the paper
 * or in the printer's margin, words broken mid-word, text too faint for its background, blocks that had to move.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Entity } from '@weldsuite/db/schema';
import { invoiceTemplateData, type InvoiceRenderData } from '../accounting-invoice-html';
import type { InvoiceDocumentData } from './data';
import { textWidth } from './fonts';
import { layoutInvoice, type InvoiceLayout, type Primitive } from './layout';
import { contrast } from './preset-kit';
import { TEMPLATE_PRESETS, presetTemplate } from './presets';
import { invoiceTemplateDocumentSchema, type PaperSize } from './schema';

/** Words the engine broke mid-word because they did not fit their box. */
const brokenWords = vi.hoisted(() => new Set<string>());

vi.mock('./fonts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fonts')>();
  return {
    ...original,
    wrapText: (...args: Parameters<typeof original.wrapText>) => {
      const lines = original.wrapText(...args);
      const words = new Set(args[0].split(/[ \r\n\t]+/));
      if (lines.some((line) => line.split(/ +/).some((token) => token && !words.has(token)))) brokenWords.add(`"${args[0]}" in ${args[3].toFixed(1)}pt`);
      return lines;
    },
  };
});

function entity(locale: string): Entity {
  return {
    id: 'ent_sample',
    name: 'Northpeak Studio',
    legalName: 'Northpeak Studio B.V.',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    locale,
    contact: { email: 'billing@northpeak.studio', phone: '+31 20 794 1180', website: 'northpeak.studio' },
    address: { line1: 'Herengracht 182', postalCode: '1016 BR', city: 'Amsterdam', country: 'NL' },
    taxIdentifiers: { vatNumber: 'NL862413579B01', registrationNumber: '81234567' },
    bankDetails: { iban: 'NL91ABNA0417164300', bic: 'ABNANL2A', bankName: 'ABN AMRO' },
    branding: {
      footerText: 'Northpeak Studio B.V. · Herengracht 182, Amsterdam · KvK 81234567',
      paymentInstructions: 'Please pay within 30 days and mention the invoice number.',
      termsAndConditions: 'Payment is due within the term stated on this invoice. Overdue amounts may be charged statutory interest.',
    },
  } as unknown as Entity;
}

const SHORT_ITEMS = [
  { description: 'Brand identity workshop', quantity: '1', unitPrice: '1450', taxRate: '21', lineTotal: '1450', taxAmount: '304.50' },
  { description: 'Website design, 6 page templates', quantity: '6', unitPrice: '480', taxRate: '21', lineTotal: '2880', taxAmount: '604.80' },
  { description: 'Hosting and maintenance (October)', quantity: '1', unitPrice: '95', taxRate: '21', lineTotal: '95', taxAmount: '19.95' },
];

const LONG_NAMES = [
  'Discovery interviews and stakeholder mapping',
  'Content audit of the existing website, including recommendations for every section',
  'Copywriting, product pages',
  'Photography day, edit and retouching',
  'Print-ready brochure, 12 pages',
  'Translation into Dutch',
  'Accessibility review (WCAG 2.2 AA)',
  'Analytics setup',
];

function longItems() {
  return Array.from({ length: 34 }, (_, i) => {
    const quantity = (i % 5) + 1;
    const price = 60 + ((i * 37) % 400);
    const rate = i % 4 === 0 ? 9 : 21;
    const line = quantity * price;
    return {
      description: LONG_NAMES[i % LONG_NAMES.length],
      quantity: String(quantity),
      unitPrice: String(price),
      taxRate: String(rate),
      lineTotal: String(line),
      taxAmount: String((line * rate) / 100),
    };
  });
}

function invoice(kind: 'short' | 'long'): InvoiceRenderData {
  const long = kind === 'long';
  const items = long ? longItems() : SHORT_ITEMS;
  const subtotal = items.reduce((s, i) => s + Number(i.lineTotal), 0);
  const tax = items.reduce((s, i) => s + Number(i.taxAmount), 0);
  const at21 = items.filter((i) => i.taxRate === '21').reduce((s, i) => s + Number(i.lineTotal), 0);
  const total = subtotal + tax - (long ? 250 : 0);
  return {
    invoiceNumber: long ? 'INV-2026-0187' : 'INV-2026-0142',
    type: 'standard',
    issueDate: '2026-10-16T00:00:00.000Z',
    dueDate: '2026-11-15T00:00:00.000Z',
    currency: 'EUR',
    contactName: long ? 'Van der Berg & Zonen Internationale Logistiek B.V.' : 'Acme Industries B.V.',
    contactEmail: 'accounts@acme.example',
    contactVatNumber: long ? 'DE811569869' : null,
    complianceNotices: long ? ['VAT reverse-charged: Article 196 of Directive 2006/112/EC'] : [],
    billingAddress: { line1: long ? 'Industrieweg 1180, Unit 4B' : 'Coolsingel 40', postalCode: '3011 AD', city: 'Rotterdam', country: 'NL' },
    shippingAddress: long ? { line1: 'Warehouse 7, Havenstraat 22', postalCode: '1561 AA', city: 'Krommenie', country: 'NL' } : null,
    reference: 'PO-77810',
    notes: long ? 'Delivery split over two shipments as agreed on 2 October. Questions? Reply to this invoice or call us.' : 'Thank you for your business.',
    items,
    subtotal: String(subtotal),
    discountTotal: long ? '250' : '0',
    taxTotal: String(tax),
    total: String(total),
    amountPaid: long ? '1000' : undefined,
    balanceDue: long ? String(total - 1000) : undefined,
    taxBreakdown: [
      { taxRateName: 'VAT 21%', taxRate: 21, taxableAmount: at21, taxAmount: at21 * 0.21 },
      ...(subtotal > at21 ? [{ taxRateName: 'VAT 9%', taxRate: 9, taxableAmount: subtotal - at21, taxAmount: (subtotal - at21) * 0.09 }] : []),
    ],
  } as InvoiceRenderData;
}

/** The layout only needs the logo's box; the checks assume a dark wordmark (`LOGO_COLOR`), as most logos are. */
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const LOGO_COLOR = '#1f2a44';

type Text = Extract<Primitive, { kind: 'text' }>;
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const boxOf = (p: Text): Box => ({ x0: p.x, y0: p.y - p.size * 0.78, x1: p.x + textWidth(p.text, p.size, p.face), y1: p.y + p.size * 0.22 });
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** The colour under a point: the last filled rectangle painted before primitive `before`, white otherwise. */
function backgroundAt(primitives: Primitive[], before: number, x: number, y: number): string {
  let bg = '#ffffff';
  for (let j = 0; j < before; j++) {
    const r = primitives[j];
    if (r.kind === 'rect' && r.fill && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) bg = r.fill;
  }
  return bg;
}

/** What a reader would notice on the printed pages. */
function problems(layout: InvoiceLayout): string[] {
  const found: string[] = [];
  layout.pages.forEach((page, pi) => {
    const texts = page.primitives.flatMap((p, i) => (p.kind === 'text' ? [{ p, i, box: boxOf(p) }] : []));
    for (const { p, i, box } of texts) {
      // Office printers leave about 6 mm unprinted.
      if (box.x0 < 24 || box.x1 > layout.width - 24 || box.y0 < 20 || box.y1 > layout.height - 20) found.push(`p${pi + 1}: "${p.text}" in the printer margin`);
      const ratio = contrast(p.color, backgroundAt(page.primitives, i, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2));
      const large = p.size >= 14 || (p.size >= 11 && Boolean(p.face.bold));
      if (ratio < (large ? 3 : 4)) found.push(`p${pi + 1}: "${p.text}" contrast ${ratio.toFixed(2)}`);
    }
    for (let a = 0; a < texts.length; a++) {
      for (let b = a + 1; b < texts.length; b++) {
        if (overlap(texts[a].box, texts[b].box) > 2) found.push(`p${pi + 1}: "${texts[a].p.text}" overlaps "${texts[b].p.text}"`);
      }
    }
    page.primitives.forEach((p, i) => {
      if (p.kind !== 'image') return;
      const bg = backgroundAt(page.primitives, i, p.x + p.w / 2, p.y + p.h / 2);
      if (contrast(LOGO_COLOR, bg) < 4.5) found.push(`p${pi + 1}: logo on ${bg}`);
    });
  });
  return found;
}

interface Case {
  name: string;
  size: PaperSize;
  kind: 'short' | 'long';
  locale: string;
  accent?: string;
}

const CASES: Case[] = [
  { name: 'A4', size: 'a4', kind: 'short', locale: 'en-GB' },
  { name: 'Letter', size: 'letter', kind: 'short', locale: 'en-US' },
  { name: 'Dutch', size: 'a4', kind: 'short', locale: 'nl-NL' },
  { name: 'a pale accent', size: 'a4', kind: 'short', locale: 'en-GB', accent: '#f2c94c' },
  { name: 'a dark accent', size: 'a4', kind: 'short', locale: 'en-GB', accent: '#7c2d12' },
  { name: 'a long invoice', size: 'a4', kind: 'long', locale: 'en-GB' },
  { name: 'a long invoice on Letter', size: 'letter', kind: 'long', locale: 'nl-NL' },
];

describe.each(TEMPLATE_PRESETS)('the %s preset', (preset) => {
  it.each(CASES)('lays out $name cleanly', ({ size, kind, locale, accent }) => {
    const template = presetTemplate(preset, size, accent);
    expect(invoiceTemplateDocumentSchema.safeParse(template).success).toBe(true);
    const data: InvoiceDocumentData = { ...invoiceTemplateData(invoice(kind), entity(locale)), logoUrl: LOGO };
    brokenWords.clear();
    const layout = layoutInvoice(template, data);
    expect(problems(layout)).toEqual([]);
    expect([...brokenWords]).toEqual([]);
    if (kind === 'long') {
      expect(layout.pages.length).toBeGreaterThan(1);
    } else {
      // A three-line invoice fits the design as drawn: nothing has to grow or move.
      expect(layout.pages).toHaveLength(1);
      expect(layout.placements.filter((p) => p.grew || p.moved).map((p) => p.id)).toEqual([]);
    }
  });

  it('prints the page number and footer on every page of a long invoice', () => {
    const data: InvoiceDocumentData = { ...invoiceTemplateData(invoice('long'), entity('en-GB')), logoUrl: null };
    const layout = layoutInvoice(presetTemplate(preset, 'a4'), data);
    layout.pages.forEach((page, i) => {
      const texts = page.primitives.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join(' ');
      expect(texts).toContain(`${i + 1} / ${layout.pages.length}`);
      expect(texts).toContain('KvK 81234567');
    });
  });
});
