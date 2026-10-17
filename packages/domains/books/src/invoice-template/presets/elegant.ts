/**
 * "Elegant": refined stationery in Times. A centred letterhead (logo, the seller and its contact details in two muted
 * lines, a hairline accent rule), a centred title over the facts, the parties under them, hairlines instead of fills,
 * and a centred sign-off that closes the letter.
 */
import { doc, legible, page } from '../preset-kit';
import type { InvoiceTemplateDocument, LabelStyle, LineItemColumn, PaperSize } from '../schema';

export default function elegant(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  // Wine by default; a pale brand colour is deepened so the labels, title and total stay readable.
  const ink = legible(accent ?? '#7b2d43');

  // Grid: text runs between M and R; rules and the table hang out by the table's cell padding, so cell text lines up with M and R.
  const M = 62;
  const R = W - M;
  const CW = R - M;
  const PAD = 4;
  const GUTTER = 16;
  const COL = (CW - 2 * GUTTER) / 3;
  const COL2 = M + COL + GUTTER;
  const COL3 = R - COL;

  // Vertical rhythm on a 4pt grid.
  const LOGO_Y = 48;
  const SELLER_Y = 96;
  const CONTACT_Y = SELLER_Y + 12;
  const RULE_Y = 128;
  // Rule, title, facts, parties, table: everything above the parties has a fixed height, so a long addressee only pushes the table.
  const TITLE_Y = 144;
  const FACTS_Y = 196;
  const PARTIES_Y = 248;
  const BILL_H = 64;
  // The ship-to address under the bill-to one, in a 1pt box: an absent one leaves only the gap above the table, a present one pushes the table down.
  const SHIP_Y = PARTIES_Y + BILL_H + 8;
  const TABLE_Y = SHIP_Y + 20;
  // The table's designed height is what three rows need, so the closing section keeps the same 32pt under the last row on any page.
  const TABLE_H = 88;
  const CLOSE_Y = TABLE_Y + TABLE_H + 32;
  const TOTALS_Y = CLOSE_Y - 2;
  const TERMS_Y = CLOSE_Y + 72;
  const LEGAL_Y = TERMS_Y + 40;
  const NOTES_Y = LEGAL_Y + 24;
  // The totals box reaches down to 16pt above the sign-off, so only a totals taller than that pushes the sign-off.
  const TOTALS_H = NOTES_Y - 16 - TOTALS_Y;
  const FOOT_RULE_Y = H - 60;

  const columns: LineItemColumn[] = [
    { key: 'description', width: 47 },
    { key: 'quantity', width: 11 },
    { key: 'unitPrice', width: 16 },
    { key: 'taxRate', width: 10 },
    { key: 'amount', width: 16 },
  ];
  const tableX = M - PAD;
  const tableW = CW + 2 * PAD;
  // The closing uses the same three-column grid: totals in the third column (ending at R, with the amounts), payment, terms
  // and the legal notices across the first two.
  const leftW = COL3 - GUTTER - M;

  const label: LabelStyle = { bold: false, fontSize: 7.5, color: 'accent', uppercase: true };
  const muted = { fontSize: 8, color: 'muted' } as const;
  // Wrapping collapses plain spaces but keeps no-break ones, so this sets an em of space between the values. A missing value
  // leaves only blank space: centred, or 3pt off centre when the first or last one is missing.
  const SEP = ' \u00a0\u00a0 ';
  // A party puts 3pt between its label and the name, a field 2pt; 2pt more line height drops a field's value by that 1pt, so labels and values both line up.
  const besideParty = { align: 'right', lineHeight: 1.3 + 2 / 9.5 } as const;

  return doc(
    paperSize,
    { font: 'times', accent: ink, text: '#221d1f', muted: '#6e6668', fontSize: 9.5 },
    [
      // Letterhead
      // Without a logo, the name set large in the logo's box, so it reads as the mark and the line under it as the fine print.
      // The box spans the measure so a long legal name (up to ~55 characters) stays on one line: a wrapped one would take 40pt
      // a line and push the page down. A logo is drawn 40pt high, centred, whatever the box's width.
      { id: 'logo', type: 'logo', x: M, y: LOGO_Y, w: CW, h: 40, align: 'center', fallbackStyle: { fontSize: 18, bold: false, uppercase: false, align: 'center', lineHeight: 40 / 18 } },
      // Name, address and registration on one line; with the contact details too it would wrap. Those get a centred line of
      // their own, kept apart by no-break spaces rather than dots, so a missing value leaves no stray separator.
      { id: 'seller', type: 'seller', x: M, y: SELLER_Y, w: CW, h: 12, inline: true, showContact: false, label: { show: false }, style: { ...muted, align: 'center' } },
      { id: 'sellerContact', type: 'text', text: `{{sellerPhone}}${SEP}{{sellerEmail}}${SEP}{{sellerWebsite}}`, x: M, y: CONTACT_Y, w: CW, h: 12, style: { ...muted, align: 'center' } },
      { id: 'letterheadRule', type: 'line', x: M - PAD, y: RULE_Y, w: CW + 2 * PAD, h: 4, color: 'accent', thickness: 0.5 },

      // Title and the facts, left / centre / right
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: M, y: TITLE_Y, w: CW, h: 36, style: { fontSize: 28, color: 'accent', align: 'center', lineHeight: 1.2 } },
      { id: 'issueDate', type: 'field', field: 'issueDate', x: M, y: FACTS_Y, w: COL, h: 28, label, style: { align: 'left' } },
      { id: 'number', type: 'field', field: 'invoiceNumber', x: COL2, y: FACTS_Y, w: COL, h: 28, label, style: { align: 'center' } },
      { id: 'dueDate', type: 'field', field: 'dueDate', x: COL3, y: FACTS_Y, w: COL, h: 28, label, style: { align: 'right' } },

      // Parties: the addresses stacked over the first two columns, the buyer's references right-aligned in the third.
      { id: 'billTo', type: 'billTo', x: M, y: PARTIES_Y, w: leftW, h: BILL_H, label },
      { id: 'shipTo', type: 'shipTo', x: M, y: SHIP_Y, w: leftW, h: 1, label },
      // Both at full size, so neither grows or pushes, and an absent place of supply simply ends the column. Place of supply sits
      // three of billTo's 9.5pt x 1.3 lines lower, so its value shares the baseline of billTo's fourth line.
      { id: 'reference', type: 'field', field: 'reference', x: COL3, y: PARTIES_Y, w: COL, h: 28, label, style: besideParty },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', x: COL3, y: PARTIES_Y + 3 * 9.5 * 1.3, w: COL, h: 28, label, style: besideParty },

      {
        id: 'items',
        type: 'lineItems',
        x: tableX,
        y: TABLE_Y,
        w: tableW,
        h: TABLE_H,
        columns,
        header: { bold: false, uppercase: true, fontSize: 7.5, color: 'accent', rule: 'accent' },
        // A warm neutral grey, so the row rules suit any brand colour picked later.
        rowRule: '#e8e4e5',
      },

      // Closing in two columns, then the note centred across the page as a sign-off that mirrors the letterhead. It spans the
      // totals column, so a taller totals block pushes it down; without a note nothing is left behind.
      { id: 'payment', type: 'payment', x: M, y: CLOSE_Y, w: leftW, h: 56, label },
      { id: 'terms', type: 'terms', x: M, y: TERMS_Y, w: leftW, h: 36, label, style: muted },
      { id: 'notes', type: 'notes', x: M, y: NOTES_Y, w: CW, h: 16, label: { show: false }, style: { fontSize: 10, italic: true, align: 'center' } },
      // Raised 2pt so the first row shares the payment label's baseline; within 4pt, so the two stay one row across pages.
      { id: 'totals', type: 'totals', x: COL3, y: TOTALS_Y, w: COL, h: TOTALS_H, total: { fontSize: 12, color: 'accent', rule: 'accent' } },
      // Notices such as reverse charge are statements the buyer must act on: bold body ink (the engine sets them bold), a step
      // below the body size so they do not read as a second total. Last in the column, so without notices nothing is left behind.
      { id: 'legal', type: 'legal', x: M, y: LEGAL_Y, w: leftW, h: 12, style: { fontSize: 8.5, color: 'text' } },
      // Keeps the closing on one page. The engine moves blocks to the next page by rows (tops within 4pt), so near the foot of a
      // page the sign-off alone could spill onto a page of its own. This empty, invisible block opens the first row and reaches to
      // the sign-off's foot: whenever the sign-off would not fit, the whole closing moves with it. It sits in the gutter and never
      // grows, so it pushes nothing.
      { id: 'closingKeep', type: 'text', text: '', x: COL3 - GUTTER, y: TOTALS_Y, w: GUTTER, h: NOTES_Y + 16 - TOTALS_Y },

      // Footer, centred, on every page
      { id: 'footerRule', type: 'line', x: M - PAD, y: FOOT_RULE_Y, w: CW + 2 * PAD, h: 4, everyPage: true, color: 'accent', thickness: 0.5 },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_RULE_Y + 12, w: CW, h: 12, everyPage: true, style: { ...muted, align: 'center' } },
      // The number on every page, so a loose continuation page still says which invoice it belongs to; it and the page number
      // share one line, either side of a centred dot like the footer's own separators.
      { id: 'footerNumber', type: 'field', field: 'invoiceNumber', layout: 'value', x: M, y: FOOT_RULE_Y + 24, w: W / 2 - 6 - M, h: 12, everyPage: true, style: { ...muted, align: 'right' } },
      { id: 'footerSeparator', type: 'text', text: '·', x: W / 2 - 6, y: FOOT_RULE_Y + 24, w: 12, h: 12, everyPage: true, style: { ...muted, align: 'center' } },
      { id: 'page', type: 'pageNumber', x: W / 2 + 6, y: FOOT_RULE_Y + 24, w: R - W / 2 - 6, h: 12, everyPage: true, style: { ...muted, align: 'left' } },
    ],
    // 16pt clear above the footer rule, so a full page's last row never crowds it.
    { top: 64, bottom: 76 },
  );
}
