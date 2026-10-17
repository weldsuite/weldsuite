/**
 * "Minimal": Times, a lot of white space and no fills. The title and the logo hang from the same top line, the
 * facts and the parties share one three-column grid and one 12pt leading, and hairlines are the only decoration.
 * Made for email delivery: the bill-to sits in the right-hand column, so a left-window envelope (DIN 5008, EA5/6, US #10)
 * shows the invoice facts, not the address.
 */
import { doc, legible, page } from '../preset-kit';
import type { InvoiceTemplateDocument, LabelStyle, LineItemColumn, PaperSize } from '../schema';

export default function minimal(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);

  // Grid: text runs between M and R in three columns. The table hangs out by its 4pt cell padding on purpose, so its cell text
  // (and the Amount figures) line up with M and R; its rules therefore run 4pt past the Total rule. Set a rule inset of 4 if
  // the engine ever gets one, rather than moving the table in.
  const M = 56;
  const R = W - M;
  const CW = R - M;
  const PAD = 4;
  const GUTTER = 24;
  const COL = (CW - 2 * GUTTER) / 3;
  const COL2 = M + COL + GUTTER;
  const COL3 = R - COL;
  const WIDE = 2 * COL + GUTTER;
  // A 4:1 wordmark fills the logo box exactly; other shapes are centred in it. Kept smaller than the title's visual weight; the box
  // starts right of the seller column, so a seller-name fallback that wraps can only ever sit over the bill-to column.
  const LOGO_W = 144;

  // Body text is set 9.5/12; a stacked label takes its own line (8.5 × 1.3) plus the engine's 3pt gap, 14.05pt, rounded to 14
  // so every coordinate the designer shows is a whole number.
  const SIZE = 9.5;
  const LEAD = 12 / SIZE;
  const LABEL_H = 14;
  // The facts fill the first column (room for a 15-character invoice number after the Dutch label); the values still stop a
  // full gutter short of the seller column, so each reads with its own label.
  const FACT_W = COL;

  // Vertical rhythm on a 4pt grid.
  const HEAD_Y = 52;
  const ROW_Y = 128;
  // The seller is the longest party: name, street, postcode and city, email, phone, website and both tax numbers, plus a
  // country line when the buyer is abroad (14 + 9 × 12 = 122). The spare 6pt puts its midline (192) under the fifth fact's
  // top (190), so on a phone all the facts stay one list, ahead of From and Bill to.
  const SELLER_H = 128;
  // A buyer needs less: a two-line name, street, postcode and city, country, email and VAT number (14 + 7 × 12 = 98).
  const BILL_H = 104;
  // The table opens 28pt under the seller, the same step the closing blocks keep under the table.
  const TABLE_Y = ROW_Y + SELLER_H + 28;
  // Separate blocks sit 16pt apart throughout, here too, so a ship-to never reads as the tail of the bill-to. Its empty box
  // reaches to 16pt above the table, so a ship-to that pushes the table down still ends 16pt above it.
  const SHIP_Y = ROW_Y + BILL_H + 16;
  const SHIP_H = TABLE_Y - 16 - SHIP_Y;
  // Three rows fill the table; a short invoice shows no blank band under its last row.
  const TABLE_H = 92;
  const CLOSE_Y = TABLE_Y + TABLE_H + 28;
  // Payment details open the left column, level with the totals; the totals already show Balance due once something is paid.
  const PAY_Y = CLOSE_Y;
  const PAY_H = 56;
  const TERMS_Y = PAY_Y + PAY_H + 16;
  const TERMS_H = 24;
  // Small print stops at the page's centre axis (the middle column's centre, the footer's axis): a shorter measure than the
  // payment block above it, so a two-sentence paragraph breaks into balanced lines instead of leaving a one-word widow.
  const AXIS = W / 2;
  const TERMS_W = AXIS - M;
  const NOTES_Y = TERMS_Y + TERMS_H + 16;
  const TOTALS_H = 56;
  // Footer: the company line, then the invoice number and page number on one line either side of the centre axis (so a
  // separated continuation page still names its invoice). The body stops 24pt above it, so it never reads as a table row.
  const FOOT_Y = H - 56;
  const FOOT_GAP = 24;

  // No fills, so the accent is only ever ink (title, rules): a pale brand colour is shaded once, to small-text
  // contrast, and every accent element uses the same token. A dark accent is kept exactly as given.
  const ink = legible(accent ?? '#1a1a1f');

  const label: LabelStyle = { uppercase: false, fontSize: 8.5 };
  const body = { lineHeight: LEAD } as const;
  const small = { fontSize: 8, color: 'muted', lineHeight: 1.5 } as const;

  // Figure columns in points (relative widths are percentages of the table); the description takes the rest.
  const tableW = CW + 2 * PAD;
  const figures: Array<[LineItemColumn['key'], number]> = [
    ['quantity', 56],
    ['unitPrice', 76],
    ['taxRate', 48],
    ['amount', 76],
  ];
  const pct = (pt: number) => (pt / tableW) * 100;
  const columns: LineItemColumn[] = [
    { key: 'description', width: pct(tableW - figures.reduce((sum, [, pt]) => sum + pt, 0)) },
    ...figures.map(([key, pt]) => ({ key, width: pct(pt) })),
  ];

  // One fact per 12pt line, starting on the parties' first line (under their labels).
  const fact = (id: string, field: 'invoiceNumber' | 'issueDate' | 'dueDate' | 'reference' | 'placeOfSupply', row: number) =>
    ({ id, type: 'field', field, layout: 'inline', x: M, y: ROW_Y + LABEL_H + row * 12, w: FACT_W, h: 12, label, style: body }) as const;

  return doc(
    paperSize,
    { font: 'times', accent: ink, text: '#1a1a1f', muted: '#6b6b72', fontSize: SIZE },
    [
      // Title and logo hang from the same line: at a 0.85 line height (any size) the engine puts Times' cap height exactly at the
      // top of the box, so the seller-name fallback uses it too; at 13pt only a name of about 28+ characters wraps, and tightly.
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: M, y: HEAD_Y, w: CW - LOGO_W - GUTTER, h: 24, style: { fontSize: 28, color: 'accent', lineHeight: 0.85 } },
      { id: 'logo', type: 'logo', x: R - LOGO_W, y: HEAD_Y, w: LOGO_W, h: LOGO_W / 4, align: 'right', fallbackStyle: { fontSize: 13, bold: false, align: 'right', lineHeight: 0.85 } },

      // Facts | seller | bill to, on one grid. India's place of supply is a fact of the invoice, so it ends the facts; the
      // optional ship-to hangs under the bill-to and pushes the table down.
      fact('number', 'invoiceNumber', 0),
      fact('issueDate', 'issueDate', 1),
      fact('dueDate', 'dueDate', 2),
      fact('reference', 'reference', 3),
      fact('placeOfSupply', 'placeOfSupply', 4),
      { id: 'seller', type: 'seller', x: COL2, y: ROW_Y, w: COL, h: SELLER_H, label, style: body },
      { id: 'billTo', type: 'billTo', x: COL3, y: ROW_Y, w: COL, h: BILL_H, label, style: body },
      { id: 'shipTo', type: 'shipTo', x: COL3, y: SHIP_Y, w: COL, h: SHIP_H, label, style: body },

      {
        id: 'items',
        type: 'lineItems',
        x: M - PAD,
        y: TABLE_Y,
        w: tableW,
        h: TABLE_H,
        columns,
        header: { uppercase: false, fontSize: 8.5, rule: 'accent' },
        // About 23% grey: quiet next to the header rule, but a 0.5pt rule this dark still prints on a toner-saving laser.
        rowRule: '#c4c4ca',
      },

      // Closing: payment, terms and notes on the left, totals and legal on the right; the optional blocks end a column.
      { id: 'payment', type: 'payment', x: M, y: PAY_Y, w: WIDE, h: PAY_H, label, style: body },
      { id: 'terms', type: 'terms', x: M, y: TERMS_Y, w: TERMS_W, h: TERMS_H, label: { show: false }, style: small },
      { id: 'notes', type: 'notes', x: M, y: NOTES_Y, w: WIDE, h: 28, label, style: body },
      // Raised 1pt so the Subtotal row shares its baseline with the payment label beside it.
      { id: 'totals', type: 'totals', x: COL3, y: CLOSE_Y - 1, w: COL, h: TOTALS_H, style: body, total: { fontSize: 11.5, rule: 'accent' } },
      // The engine sets notices in bold; a smaller size keeps them a step under Total and Balance due. 8pt under the totals so a
      // phone reads it straight after them, before the small print.
      { id: 'legal', type: 'legal', x: COL3, y: CLOSE_Y + TOTALS_H + 8, w: COL, h: 12, style: { fontSize: 8.5, lineHeight: 12 / 8.5 } },

      // Footer, on the centre axis, on every page.
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: CW, h: 12, everyPage: true, style: { ...small, align: 'center' } },
      { id: 'footerNumber', type: 'field', field: 'invoiceNumber', layout: 'value', x: M, y: FOOT_Y + 12, w: AXIS - 6 - M, h: 12, everyPage: true, style: { ...small, align: 'right' } },
      { id: 'page', type: 'pageNumber', x: AXIS + 6, y: FOOT_Y + 12, w: R - AXIS - 6, h: 12, everyPage: true, style: { ...small, align: 'left' } },
    ],
    { top: HEAD_Y, bottom: H - FOOT_Y + FOOT_GAP },
  );
}
