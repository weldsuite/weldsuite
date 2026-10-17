/**
 * "Bold": a poster-like invoice. A very large title owns the top, the amount due and its due date sit
 * top right in one glance, the table header is a solid dark bar and a thick accent rule closes the table.
 * Made for emailed PDFs: the customer address sits under the dates, not in a window-envelope position.
 */
import { doc, legible, page, readableOn } from '../preset-kit';
import type { InvoiceTemplateDocument, PaperSize } from '../schema';

// Vivid, and already 4.5:1 on white, so the rules, the amount due and the "Balance due" row share one red.
const VERMILION = '#d43a1e';
const TEXT = '#15161a';
const MUTED = '#676b76';

export default function bold(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  const brand = accent ?? VERMILION;
  const ink = legible(brand);
  // Most brand colours read as text as they are: then everything uses the 'accent' token and follows a later accent change.
  // A pale accent keeps its own colour on the rules only; text gets the shaded ink (the theme accent).
  const rule = ink === brand ? 'accent' : brand;

  // Grid: 44pt side margins, five columns with 12pt gutters. Columns 0-2 carry the logo, title and customer,
  // columns 3-4 the "pay" column: the sender's contact, amount due, due date, the sender, totals.
  const M = 44;
  const CW = W - 2 * M;
  const G = 12;
  const C = (CW - 4 * G) / 5;
  const col = (i: number) => M + i * (C + G);
  const span = (n: number) => n * C + (n - 1) * G;
  const PAY_X = col(3);
  const PAY_W = span(2);
  const HANG = 4;

  // Vertical rhythm (multiples of 4). A caption line (7.5pt) and a body line (9pt) at line height 1.3.
  const CAPTION = 7.5 * 1.3;
  const LINE = 9 * 1.3;
  const RULE_Y = 40;
  const LOGO_Y = 64;
  const TITLE_Y = 116;
  const META_Y = 176;
  const PARTY_Y = 228;
  // Label, name, street, city, registration and VAT number (9pt), plus a country line on a cross-border invoice.
  const PARTY_H = 84;
  const TABLE_Y = PARTY_Y + PARTY_H + 24;
  // Exactly three rows tall: with three items the accent rule lands on the last row's hairline.
  const ROW_PAD = 6;
  const TABLE_H = 8 * 1.3 + 2 * ROW_PAD + 3 * (9 * 1.3 + 2 * ROW_PAD);
  const TABLE_END = TABLE_Y + TABLE_H;
  // Under the table the words stack in the left column (payment, the legal notice, terms, notes) and the totals
  // own the right one, so each column only pushes itself and nothing waits for the other column to end. The legal
  // notice sits right under the payment, beside the VAT it qualifies, so it is never set a page after them;
  // its designed slot is only 0.5pt tall, so an invoice without one keeps no hole. Notes come last: they are the
  // most often empty. A free-standing separator rule would open the next page under the accent rule, so
  // sections are divided by space and labels only: 20pt of white between them.
  const SUM_Y = TABLE_END + 32;
  // Subtotal, one VAT rate and the Total (14pt with its 5pt padding) fill 57.6pt.
  const SUM_H = 60;
  // The payment label is 7.5pt, the totals rows 9pt: this puts "PAYMENT" on the "Subtotal" baseline.
  const LABEL_DROP = 1.36;
  const PAY_Y = SUM_Y + LABEL_DROP;
  // Exactly the label, IBAN, BIC and one line of instructions (4pt paragraph gap): the slots under it start where it ends.
  const PAY_H = CAPTION + 3 + 2 * LINE + 4 + LINE;
  // The legal notice is the payment's last paragraph: one paragraph gap (4pt) under it, on the same 9pt as its text.
  const LEGAL_Y = PAY_Y + PAY_H + 4;
  const LEGAL_H = 0.5;
  // 4 + 0.5 + 15.5: the terms keep the 20pt section gap to the payment when there is no notice.
  const TERMS_Y = LEGAL_Y + LEGAL_H + 15.5;
  // Label and two lines of 9pt terms.
  const TERMS_H = CAPTION + 3 + 2 * LINE;
  const NOTES_Y = TERMS_Y + TERMS_H + 20;
  const NOTES_H = 28;
  const FOOT_Y = H - 44;

  const value = { fontSize: 10, bold: true };
  const small = { fontSize: 8, color: 'muted' as const };
  // Facts may use most of the gutter, so long dates ("September 28, 2026") stay on one line; the last keeps the right edge.
  const fact = (id: string, field: 'invoiceNumber' | 'issueDate' | 'dueDate' | 'reference' | 'placeOfSupply', i: number) =>
    ({ id, type: 'field', field, x: col(i), y: META_Y, w: i < 4 ? C + G - 4 : C, h: 28, style: value }) as const;

  return doc(
    paperSize,
    { font: 'helvetica', accent: ink, text: TEXT, muted: MUTED, fontSize: 9 },
    [
      // The rules and the table hang 4pt past the content edges (the table's cell padding): row text then starts
      // on the left edge and the amounts end on the right edge, flush with the amount due and the totals.
      { id: 'topRule', type: 'line', x: M - HANG, y: RULE_Y, w: CW + 2 * HANG, h: 4, everyPage: true, color: rule, thickness: 4 },
      // Without a logo the name is set solid (line height 1), so its cap height also starts on the logo's top edge.
      { id: 'logo', type: 'logo', x: M, y: LOGO_Y, w: span(3), h: 36, fallbackStyle: { fontSize: 14, bold: true, color: 'text', lineHeight: 1 } },
      // Letterhead contact beside the logo, one item per line (no " · " runs that wrap mid-item), 12pt apart and flush
      // right; a missing item closes up. The full width of the pay column, so a long e-mail address does not break.
      // 2pt up (the half-leading of the 12pt line): the first line's cap height starts on the logo's top edge.
      {
        id: 'sellerContact',
        type: 'text',
        text: '{{sellerEmail}}\n{{sellerPhone}}\n{{sellerWebsite}}',
        x: PAY_X,
        y: LOGO_Y - 2,
        w: PAY_W,
        h: 36,
        style: { ...small, align: 'right', lineHeight: 1.5 },
      },
      {
        id: 'title',
        type: 'field',
        field: 'title',
        layout: 'value',
        // 40pt Helvetica Bold has ~2pt side bearing: the stem lands optically on the 44pt edge.
        x: M - 2,
        y: TITLE_Y,
        // Mixed case: the longest real label ("Nota de crédito", 291pt) stays on one line, with room to spare in the gutter.
        w: span(3) + G - 4,
        h: 48,
        style: { fontSize: 40, bold: true, color: 'text', uppercase: false, lineHeight: 1.15 },
      },
      // The amount sits on the title's baseline.
      {
        id: 'balanceDue',
        type: 'field',
        field: 'balanceDue',
        layout: 'stacked',
        x: PAY_X,
        y: TITLE_Y,
        w: PAY_W,
        h: 44,
        // A pale accent shaded to text strength turns muddy: then the callout is set in the text colour instead.
        style: { fontSize: 24, bold: true, color: ink === brand ? 'accent' : 'text', lineHeight: 1.28 },
      },
      fact('number', 'invoiceNumber', 0),
      fact('issueDate', 'issueDate', 1),
      // Rarely printed: when empty, the gap sits under the title's tail, between the two groups.
      fact('placeOfSupply', 'placeOfSupply', 2),
      fact('dueDate', 'dueDate', 3),
      fact('reference', 'reference', 4),
      // Bill to, ship to and from under number/date, place of supply and due date/reference: one party per column group.
      { id: 'billTo', type: 'billTo', x: M, y: PARTY_Y, w: span(2), h: PARTY_H },
      { id: 'shipTo', type: 'shipTo', x: col(2), y: PARTY_Y, w: C, h: PARTY_H },
      // Stacked, one fact per line: the VAT number never wraps away from its label.
      { id: 'seller', type: 'seller', x: PAY_X, y: PARTY_Y, w: PAY_W, h: PARTY_H, showContact: false },
      {
        id: 'items',
        type: 'lineItems',
        x: M - HANG,
        y: TABLE_Y,
        w: CW + 2 * HANG,
        h: TABLE_H,
        columns: [
          { key: 'description', width: 47 },
          { key: 'quantity', width: 10 },
          { key: 'unitPrice', width: 16 },
          { key: 'taxRate', width: 9 },
          { key: 'amount', width: 18 },
        ],
        header: { background: 'text', color: readableOn(TEXT), uppercase: true },
        rowRule: '#e4e4e7',
        rowPadding: ROW_PAD,
      },
      { id: 'tableRule', type: 'line', x: M - HANG, y: TABLE_END, w: CW + 2 * HANG, h: 4, color: rule, thickness: 4 },
      { id: 'payment', type: 'payment', x: M, y: PAY_Y, w: span(3), h: PAY_H },
      // The Total stays below 2x the 9pt "Balance due" row, which is the payable amount once a payment is recorded.
      { id: 'totals', type: 'totals', x: PAY_X, y: SUM_Y, w: PAY_W, h: SUM_H, total: { fontSize: 14, color: 'text', rule: 'text' } },
      { id: 'legal', type: 'legal', x: M, y: LEGAL_Y, w: span(3), h: LEGAL_H, style: { fontSize: 9 } },
      // The notes' body size, so the two stay on one baseline grid.
      { id: 'terms', type: 'terms', x: M, y: TERMS_Y, w: span(3), h: TERMS_H, style: { fontSize: 9, color: 'muted' } },
      { id: 'notes', type: 'notes', x: M, y: NOTES_Y, w: span(3), h: NOTES_H },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: span(4), h: 12, everyPage: true, style: small },
      { id: 'page', type: 'pageNumber', x: col(4), y: FOOT_Y, w: C, h: 12, everyPage: true, style: { ...small, align: 'right' } },
    ],
    // The body ends 12pt above the footer line.
    { top: 64, bottom: 56 },
  );
}
