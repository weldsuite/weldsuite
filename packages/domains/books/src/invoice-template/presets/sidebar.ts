/**
 * "Sidebar": a pale tinted panel down the left of every page carries the sender, the invoice
 * details and the payment details; the main column carries the customer, the lines and the totals.
 * Not for window envelopes: the panel takes the left window's place and the customer address starts
 * left of a right window.
 */
import { doc, legible, page, tint } from '../preset-kit';
import type { InvoiceTemplateDocument, PaperSize, TextStyle } from '../schema';

const DEFAULT_ACCENT = '#3f5b8a';

export default function sidebar(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  const brand = accent ?? DEFAULT_ACCENT;
  const panelFill = tint(brand, 0.9);
  // The theme accent is the brand colour made readable on the panel (and so on white): labels, title, rules.
  const ink = legible(brand, panelFill);

  // Grid: panel P wide with its text at PX..PX+PW (152pt: a 40-character e-mail at the seller's 7pt), 10pt clear of the
  // edge line; main column text at X0..X1 (table rules overhang by 4, so the cell text sits on X0 and X1).
  const TOP = 40;
  const P = 188;
  const PX = 24;
  const PW = 152;
  const X0 = P + 24;
  const X1 = W - 36;
  const MW = X1 - X0;
  const GUTTER = 24;
  const COL = (MW - GUTTER) / 2;
  const TABLE_X = X0 - 4;
  const TABLE_W = MW + 8;
  // The main column's second half: ship-to above the table, totals under it.
  const TX = X0 + COL + GUTTER;
  // Balance due, right-aligned; the title gets the rest of the line minus a 12pt gap (NOTA DE CRÉDITO fits at 24pt).
  const BAL_W = 116;

  const PARTY_Y = 112;
  const META_PITCH = 28;
  // The table's header caps sit on the line of the panel's fourth meta label: the header row sets its text 5pt into its box
  // (the cell padding), so the table starts 5pt above that label, a point off the 4pt grid, and is a point taller to end
  // back on it.
  const TABLE_Y = PARTY_Y + 3 * META_PITCH - 5;
  const TABLE_H = 97;
  const STEP = 16;
  const AFTER_Y = TABLE_Y + TABLE_H + STEP;
  const TOTALS_H = 56;
  const TERMS_Y = AFTER_Y + TOTALS_H + STEP;
  const TERMS_H = 36;
  // Panel, one stack from the top: logo, the invoice details on the bill-to line, the seller on the details' 28pt grid one
  // empty pitch under REFERENCE, then the payment details anchored level with TERMS and free to grow down to the bottom
  // margin. A full seller (name, address, three contact lines, two tax ids) then has about 38pt of air above FROM and above
  // PAYMENT alike, the same as between the logo and the details. Its slot fits ten lines at 7pt (a country line on a
  // cross-border invoice, a wrapped name); a shorter seller leaves the space above the anchor, never a hole in the stack.
  const SELLER_Y = PARTY_Y + 5 * META_PITCH;
  const PAY_Y = TERMS_Y;
  const PAY_H = H - 64 - PAY_Y;
  // The footer line of classic and bold.
  const FOOT_Y = H - 44;
  // The panel is three stacked rectangles (each overlapping the next by a point), so a phone reads it as three cards, in
  // the reading order of the rows they start: the logo card with the title and balance due (its top half takes in the
  // title line); the details and seller card with bill-to and ship-to (it starts just under them, so the row, and its
  // depth, is theirs and the table stays out of it); the payment card with the terms (it starts between the totals and
  // the terms, so it is read after the totals).
  const META_TOP = PARTY_Y + 4;

  // Labels and table headers share one style: 7.5pt bold uppercase in the accent.
  const label = { color: 'accent', fontSize: 7.5 } as const;
  // The invoice details at 7.5pt, the size of their labels; the seller and payment blocks a half point smaller, so a
  // 40-character e-mail or a long bank line fits the panel column.
  const panelText: TextStyle = { fontSize: 7.5, lineHeight: 1.4 };
  const panelSmall: TextStyle = { fontSize: 7, lineHeight: 1.4 };
  const meta = (id: string, field: 'invoiceNumber' | 'issueDate' | 'dueDate' | 'reference', i: number, style: TextStyle = panelText) =>
    ({ id, type: 'field', field, layout: 'stacked', x: PX, y: PARTY_Y + i * META_PITCH, w: PW, h: 24, everyPage: true, label, style }) as const;

  return doc(
    paperSize,
    { accent: ink, muted: '#5f6573', fontSize: 8.5 },
    [
      { id: 'panelHead', type: 'rect', x: 0, y: 0, w: P, h: META_TOP + 1, everyPage: true, box: { background: panelFill } },
      { id: 'panelMeta', type: 'rect', x: 0, y: META_TOP, w: P, h: PAY_Y - META_TOP, everyPage: true, box: { background: panelFill } },
      { id: 'panelPayment', type: 'rect', x: 0, y: PAY_Y - 1, w: P, h: H - PAY_Y + 1, everyPage: true, box: { background: panelFill } },
      // A hairline down the panel's edge in the accent, the colour of the title and the rules.
      { id: 'panelEdge', type: 'line', x: P - 2, y: 0, w: 2, h: H, everyPage: true, orientation: 'vertical', color: 'accent', thickness: 1.5 },
      // Five points down: a wide logo's top meets the cap height of the title. Without a logo the name is set solid, so its
      // caps meet the title's too.
      { id: 'logo', type: 'logo', x: PX, y: TOP + 5, w: PW, h: 32, everyPage: true, fallbackStyle: { fontSize: 12, bold: true, lineHeight: 1 } },
      // The number customers quote when they pay is the one larger value in the panel; the due date, the one date they act
      // on, is bold.
      meta('number', 'invoiceNumber', 0, { fontSize: 10, lineHeight: 1.2, bold: true }),
      meta('issueDate', 'issueDate', 1),
      meta('dueDate', 'dueDate', 2, { ...panelText, bold: true }),
      meta('reference', 'reference', 3),
      { id: 'seller', type: 'seller', x: PX, y: SELLER_Y, w: PW, h: PAY_Y - 12 - SELLER_Y, everyPage: true, label, style: panelSmall },
      { id: 'payment', type: 'payment', x: PX, y: PAY_Y, w: PW, h: PAY_H, everyPage: true, label, style: panelSmall },

      // Title line height 1.375 puts its baseline on the balance amount's baseline.
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: X0, y: TOP, w: MW - BAL_W - 12, h: 36, style: { fontSize: 24, bold: true, color: 'accent', uppercase: true, lineHeight: 1.375 } },
      { id: 'balanceDue', type: 'field', field: 'balanceDue', layout: 'stacked', x: X1 - BAL_W, y: TOP, w: BAL_W, h: 36, label, style: { fontSize: 12, bold: true, align: 'right' } },
      // Place of supply (India GST) under the balance due, across the column so the longest state name keeps to one line; in
      // the panel an empty one would open a hole above FROM.
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', layout: 'stacked', x: X0, y: TOP + 40, w: MW, h: 24, label, style: { ...panelText, align: 'right' } },
      { id: 'billTo', type: 'billTo', x: X0, y: PARTY_Y, w: COL, h: 64, label },
      { id: 'shipTo', type: 'shipTo', x: TX, y: PARTY_Y, w: COL, h: 64, label },
      {
        id: 'items',
        type: 'lineItems',
        x: TABLE_X,
        y: TABLE_Y,
        w: TABLE_W,
        h: TABLE_H,
        columns: [
          // Every header (PRIJS PER STUK, QUANTITY) on one line, a six-digit amount on one line, and a 33-character
          // description still on one line at A4.
          { key: 'description', width: 41 },
          { key: 'quantity', width: 13 },
          { key: 'unitPrice', width: 20 },
          { key: 'taxRate', width: 10 },
          { key: 'amount', width: 16 },
        ],
        header: { color: 'accent', fontSize: 7.5, rule: 'accent' },
        rowRule: '#e3e5ea',
      },
      { id: 'notes', type: 'notes', x: X0, y: AFTER_Y, w: COL, h: 40, label },
      { id: 'totals', type: 'totals', x: TX, y: AFTER_Y, w: COL, h: TOTALS_H, total: { fontSize: 11, rule: 'accent' } },
      { id: 'terms', type: 'terms', x: X0, y: TERMS_Y, w: MW, h: TERMS_H, label, style: { fontSize: 7.5, color: 'muted' } },
      // Last and only 4pt tall: an invoice without notices leaves no gap; one with them grows downwards.
      { id: 'legal', type: 'legal', x: X0, y: TERMS_Y + TERMS_H + STEP, w: MW, h: 4 },

      { id: 'footer', type: 'text', text: '{{footerText}}', x: X0, y: FOOT_Y, w: MW - 72, h: 12, everyPage: true, style: { fontSize: 7.5, color: 'muted' } },
      { id: 'page', type: 'pageNumber', x: X1 - 60, y: FOOT_Y, w: 60, h: 12, everyPage: true, style: { fontSize: 7.5, align: 'right' } },
    ],
    // A point above TOP: on a continuation page the table's header caps (5pt into the table) meet the logo's top, as the
    // title's do on the first page.
    { top: TOP - 1, bottom: 64 },
  );
}
