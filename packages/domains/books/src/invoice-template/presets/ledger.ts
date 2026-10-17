/**
 * "Ledger": a bookkeeping form in Courier. A double rule under the title, the bill-to (in the envelope window), the
 * seller and the invoice facts in a grid of hairline cells, a ruled table without fills and the totals in a bordered
 * box whose figures stand in the table's amount column. Everything sits on one three-column grid; the accent is the
 * ink of the rules and the title.
 */
import { doc, legible, page, tint } from '../preset-kit';
import type { InvoiceTemplateDocument, LineItemColumn, PaperSize } from '../schema';

export default function ledger(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  // The ink of the title, the rules and the grand total is the brand colour, deepened until it reads. Where it needed
  // no deepening it stays the 'accent' token, so a brand colour picked later in the designer carries over.
  const brand = accent ?? '#556b2f';
  const ink = legible(brand);
  const inkTok = ink.toLowerCase() === brand.toLowerCase() ? 'accent' : ink;
  // Strong enough that the last rule on a page still reads as one, and survives toner-saving printers.
  const ruling = tint(ink, 0.7);

  // Grid: three equal columns between the margins. PAD is the table's own cell padding, so text in every cell,
  // the head, the table and the totals starts and ends on the same verticals; only the rules and frames reach M and R.
  const M = 40;
  const R = W - M;
  const CW = R - M;
  const C = CW / 3;
  const col = (i: number) => M + i * C;
  const PAD = 4;
  const cell = { borderColor: 'muted', borderWidth: 0.5, padding: PAD } as const;
  const label = { fontSize: 7 } as const;

  // Vertical rhythm on a 4pt grid. The grid starts 45mm down with the bill-to in its first cell, so the address
  // lands in the window of a left-window envelope (DIN 5008 / NL, US #10) when the folded sheet sits centred.
  const TOP = 40;
  // A 4:1 wordmark is 160pt wide at this height; the band closes 12pt under it with the double rule.
  const HEAD_Y = 60;
  const LOGO_H = 40;
  const RULE_Y = HEAD_Y + LOGO_H + 12;
  const GRID_Y = RULE_Y + 16;
  // The facts are the four that always print, as caption-over-value cells like the parties. Party lines step a third
  // of a cell, so across the row every fact's value shares its baseline with a party line (the name, the 4th, the
  // 7th). A party puts 3pt between caption and name, a field 2pt, so the value's line is 2pt taller (31.8pt a cell).
  const META_H = 32;
  const LINE = META_H / 3;
  const party = { lineHeight: LINE / 8 } as const;
  const factValue = { lineHeight: (LINE + 2) / 8 } as const;
  // Row 1 holds the worst case: a seller with address, country, email, phone, website, CoC and VAT (9 lines, 116.1pt;
  // 126.8pt with a name on two lines).
  const ROW1_H = 4 * META_H;
  const OPT_Y = GRID_Y + ROW1_H;
  // Ship-to and place of supply close the grid side by side, each skipped when empty. Empty, they keep their designed
  // height, the schema's least, so the table sits the page's 16pt section gap under the grid with or without them.
  const OPT_H = 0.5;
  const TABLE_Y = OPT_Y + 16;
  // Exactly what the header and three rows need, so the closing rule (designed at the table's end, so it follows the
  // last row to any page) lands on the last row rule. The closing row starts 16pt under the table's end.
  const TABLE_H = 80.3;
  const CLOSE_Y = TABLE_Y + 96;
  // The totals' content (57.8pt with the engine's fixed 5pt under the grand total) plus 0.2pt.
  const TOTALS_H = 58;
  // 16pt from the totals to the closing cells; a one-line notice takes the middle with 8pt on either side.
  const LEGAL_Y = CLOSE_Y + TOTALS_H + 8;
  const LEGAL_H = 0.5;
  const FOOT_Y = LEGAL_Y + 8;
  // Caption plus four lines with the payment's gap between account and instructions (65.7pt), so the usual two
  // cells close on one line; longer terms or instructions grow the row.
  const FOOT_H = 68;
  const PAGE_Y = H - 44;
  const PAGE_RULE_Y = PAGE_Y - 6;

  // Column widths in percent; quantity ends at two thirds, so the totals box stands under price, VAT and amount.
  // In 8pt Courier the index holds three digits and the amount '€ 123.456,78' on A4 as on Letter. The index is set
  // left, so the row numbers start on the same vertical as the text in the cells above.
  const columns: LineItemColumn[] = [
    { key: 'index', width: 4.5, align: 'left' },
    { key: 'description', width: 53.5 },
    { key: 'quantity', width: 26 / 3 },
    { key: 'unitPrice', width: 13.6 },
    { key: 'taxRate', width: 6.6 },
    { key: 'amount', width: 100 / 3 - 13.6 - 6.6 },
  ];

  // Courier's baseline and capital height (0.59em) in a 1.3 line box. The title's capitals start level with the ink
  // of a logo image, which typically starts about 1pt inside its box; the reference's value sits on the line its ink
  // ends on.
  const ascent = (size: number) => (1.3 * size - 0.839 * size) / 2 + 0.629 * size;
  const TITLE = 22;
  const TITLE_Y = HEAD_Y + 1 - (ascent(TITLE) - 0.59 * TITLE);
  // Caption over value, as in the cells.
  const REF_H = 7 * 1.3 + 2 + 8 * 1.3;
  const REF_Y = HEAD_Y + LOGO_H - 1 - (REF_H - 8 * 1.3 + ascent(8));

  return doc(
    paperSize,
    { font: 'courier', accent: brand, text: '#1f1d1b', muted: '#5f6268', fontSize: 8 },
    [
      { id: 'logo', type: 'logo', x: M + PAD, y: HEAD_Y, w: C - PAD, h: LOGO_H, fallbackStyle: { fontSize: 13, bold: true, lineHeight: 1 } },
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: col(2), y: TITLE_Y, w: C - PAD, h: 30, style: { fontSize: TITLE, bold: true, color: inkTok, align: 'right', uppercase: true } },
      // The one optional fact sits in the head, where leaving it out only leaves the title on its own: an empty cell in
      // the facts grid would print as a hole, since the engine skips an empty block's frame but keeps its space.
      { id: 'reference', type: 'field', field: 'reference', layout: 'stacked', x: col(2), y: REF_Y, w: C - PAD, h: REF_H, label, style: { align: 'right' } },
      { id: 'ruleHeavy', type: 'line', x: M, y: RULE_Y - 2, w: CW, h: 4, color: inkTok, thickness: 1.5 },
      { id: 'ruleLight', type: 'line', x: M, y: RULE_Y + 1, w: CW, h: 4, color: inkTok, thickness: 0.5 },

      { id: 'billTo', type: 'billTo', x: col(0), y: GRID_Y, w: C, h: ROW1_H, box: cell, label, style: party },
      { id: 'seller', type: 'seller', x: col(1), y: GRID_Y, w: C, h: ROW1_H, box: cell, label, style: party },
      ...(['invoiceNumber', 'issueDate', 'dueDate', 'balanceDue'] as const).map((field, i) => ({
        id: field === 'invoiceNumber' ? 'number' : field,
        type: 'field' as const,
        field,
        layout: 'stacked' as const,
        x: col(2),
        y: GRID_Y + i * META_H,
        w: C,
        h: META_H,
        box: cell,
        label,
        style: factValue,
      })),
      { id: 'shipTo', type: 'shipTo', x: col(0), y: OPT_Y, w: 2 * C, h: OPT_H, box: cell, label, style: party },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', layout: 'stacked', x: col(2), y: OPT_Y, w: C, h: OPT_H, box: cell, label, style: factValue },

      {
        id: 'items',
        type: 'lineItems',
        x: M,
        y: TABLE_Y,
        w: CW,
        h: TABLE_H,
        columns,
        // Muted like every other 7pt caps label; the ink rule under it carries the emphasis.
        header: { color: 'muted', rule: inkTok, fontSize: 7 },
        rowRule: ruling,
      },
      // Closes the columns in ink at the header rule's weight, over the last (pale) row rule: the line sits 0.25pt under
      // it (a line block is at least 0.5pt tall and must start at the table's end to follow it), and 1pt still covers it.
      { id: 'tableEnd', type: 'line', x: M, y: TABLE_Y + TABLE_H, w: CW, h: 0.5, color: inkTok, thickness: 1 },

      // 1pt lower than the totals, so the notes label and body share the baselines of the totals rows beside them.
      { id: 'notes', type: 'notes', x: M, y: CLOSE_Y + 1, w: 2 * C - 16, h: TOTALS_H - 1, box: { padding: PAD }, label },
      { id: 'totals', type: 'totals', x: col(2), y: CLOSE_Y, w: C, h: TOTALS_H, box: cell, total: { fontSize: 10, color: inkTok, rule: inkTok } },
      // Full width, so whatever grows above it (the totals on a long invoice) moves both closing cells alike.
      { id: 'legal', type: 'legal', x: M + PAD, y: LEGAL_Y, w: CW - 2 * PAD, h: LEGAL_H },
      { id: 'terms', type: 'terms', x: col(0), y: FOOT_Y, w: 2 * C, h: FOOT_H, box: cell, label },
      { id: 'payment', type: 'payment', x: col(2), y: FOOT_Y, w: C, h: FOOT_H, box: cell, label },

      { id: 'pageRule', type: 'line', x: M, y: PAGE_RULE_Y - 2, w: CW, h: 4, everyPage: true, color: 'muted', thickness: 0.5 },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M + PAD, y: PAGE_Y, w: CW - 2 * PAD - 72, h: 10, everyPage: true, style: { fontSize: 7, color: 'muted' } },
      { id: 'page', type: 'pageNumber', x: R - PAD - 72, y: PAGE_Y, w: 72, h: 10, everyPage: true, style: { fontSize: 7, align: 'right' } },
    ],
    { top: TOP, bottom: 60 },
  );
}
