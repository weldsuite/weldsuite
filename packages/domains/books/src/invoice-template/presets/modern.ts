/**
 * "Modern": a full-bleed accent band across the top with the logo on a white chip, the title, the invoice number
 * and the amount due; the seller and the customer beside the invoice facts, an accent-headed table with tinted
 * zebra rows, the payment details in a tinted card beside the totals (a place of supply under them when there is
 * one), the note and the terms under them, and the footer text with the invoice number and the page number under an
 * accent rule on every page.
 *
 * Made for email and PDF, not for window envelopes: the band takes the top 45 mm and the parties sit on the 14 mm
 * content edge, left of where a DIN 5008 / NEN window starts (20 mm). The "letterhead" preset is the one for posting.
 */
import { doc, legible, page, readableOn, tint } from '../preset-kit';
import type { InvoiceTemplateDocument, LineItemColumn, PaperSize, TemplateColor } from '../schema';

export default function modern(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  const a = accent ?? '#0f766e';
  // The theme accent must read as text: the engine prints the balance due row in it. A pale brand colour (yellow)
  // is deepened there, and the fills that carry the brand colour as is (band, table header, total bar, rule) then
  // bake the raw hex. A brand colour that already reads keeps the 'accent' token, so the designer recolours it.
  const themeAccent = legible(a);
  const fill: TemplateColor = themeAccent === a ? 'accent' : a;
  // Text on accent fills (band, table header, total row) is white or near-black, whichever the accent carries.
  const ink = readableOn(a);
  const wash = tint(a, 0.93);
  const zebra = tint(a, 0.95);
  // Section labels print in the accent, deepened until they read on the payment card's wash (and so on white).
  const labelColor = legible(a, wash);
  // The footer rule is the only accent stroke on a white page: a pale accent is deepened to 3:1 so it still separates
  // the footer on screen and in a greyscale print.
  const ruleColor: TemplateColor = fill === 'accent' ? 'accent' : legible(a, '#ffffff', 3);

  // Grid: content runs between M and R.
  const M = 40;
  const R = W - M;
  const CW = R - M;
  const GUTTER = 16;

  // Table columns (relative widths summing to 100): the totals and the invoice facts share the right-hand column,
  // which starts where the unit price column starts.
  const columns: LineItemColumn[] = [
    { key: 'description', width: 46 },
    { key: 'quantity', width: 11 },
    { key: 'unitPrice', width: 17 },
    { key: 'taxRate', width: 10 },
    { key: 'amount', width: 16 },
  ];
  const RX = M + (CW * (columns[0].width + columns[1].width)) / 100;
  const RW = R - RX;
  const LW = RX - GUTTER - M;
  // The seller column fits "BTW-nummer: NL862413579B01" (133pt) on one line; the customer takes the rest.
  const SELLER_W = 136;
  const BILL_X = M + SELLER_W + GUTTER;
  const BILL_W = RX - GUTTER - BILL_X;

  // Band: logo chip left, a right-aligned stack (title, number, amount due) right, the stack centred in the band. The
  // chip is top-aligned with the stack and as tall as the title and number lines together; sharing the title's top
  // also makes it the first block of the band on a phone (same y, smaller x), so the band reads logo, title, number,
  // amount due.
  const BAND_H = 128;
  const STACK_Y = 20;
  const TITLE_H = 32;
  const NUMBER_H = 16;
  // The chip is cut close around a 4:1 wordmark (inner 124 x 28), so it reads as the logo's plate, not a card.
  const CHIP_W = 144;
  const CHIP_H = TITLE_H + NUMBER_H;
  const CHIP_PAD = 10;
  const DUE_Y = STACK_Y + TITLE_H + NUMBER_H + 8;
  const DUE_H = 32;

  // Vertical rhythm on a 4pt grid.
  const PARTY_Y = BAND_H + 32;
  // FROM sets the row height: the label and nine lines (name, street, postcode and city, email, phone, website,
  // registration and VAT number, and the country line a cross-border invoice adds; 118pt). BILL TO holds six lines:
  // name, address, email and VAT number, plus a country line or a second name line. A ship-to address starts under
  // it, in a slot running to the end of the row, and pushes the table only by what it needs beyond that. The table
  // starts 20pt under the row: a domestic seller (eight lines) ends 34pt above it, a cross-border one 22pt.
  const PARTY_H = 120;
  const BILL_H = 84;
  const SHIP_Y = PARTY_Y + BILL_H + 8;
  const SHIP_H = PARTY_Y + PARTY_H - SHIP_Y;
  const ROW = 14;
  // The facts are 9pt lines, the party labels 7.5pt ones: starting the facts 1.35pt higher puts the first baselines
  // level, and a 14pt row puts the second fact level with the party names. Only date, due date and reference stack
  // here, so a missing reference leaves nothing under them.
  const FACT_Y = PARTY_Y - 1.35;
  const TABLE_Y = PARTY_Y + PARTY_H + 20;
  const TABLE_H = 96;
  const CLOSE_Y = TABLE_Y + TABLE_H + 20;
  // Closing section in two rows of two columns: the payment card beside the totals, then the note beside the terms.
  // The card and the totals share their top (top-aligned columns, whatever the number of total lines), which also
  // makes them one row that changes pages together. Between the rows two 4pt slots, empty on most invoices: the place
  // of supply (a GST statement) under the totals, then the full-width legal notices. Longer totals push them down,
  // and they push the note and the terms by the same amount, so those too stay one row. The legal slot starts 8pt
  // under the place of supply, so a phone reads them as two rows (supply first, with the totals) instead of one row
  // ordered left to right; 12pt on either side of a legal notice keep it a statement of its own.
  const CLOSE_H = 72;
  const CLOSE_B = CLOSE_Y + CLOSE_H;
  const SLOT_H = 4;
  const SUPPLY_Y = CLOSE_B + 4;
  const LEGAL_Y = SUPPLY_Y + 8;
  const AFTER_Y = LEGAL_Y + SLOT_H + 12;
  const RADIUS = 4;

  // Footer: an accent rule, then the footer text, the invoice number (so a loose continuation page can be matched to
  // its invoice) and the page number; room for a second footer line above the print limit. The footer line sits at
  // H - 44, the line the other presets share.
  const FOOT_Y = H - 44;
  const RULE_Y = FOOT_Y - 10;
  // The page number reads "2 / 3" ('{page} / {total}'); its box holds up to "99 / 99", so the invoice number sits
  // close to it at the right end of the row.
  const PAGE_W = 32;
  const REF_W = 96;
  // The body stops 16pt above the rule.
  const BOTTOM = H - RULE_Y + 16;

  const label = { color: labelColor };
  const small = { fontSize: 7.5, color: 'muted' as const };
  const fact = { label: { bold: false, color: 'muted' as const } };

  return doc(
    paperSize,
    { accent: themeAccent, muted: '#646a78' },
    [
      { id: 'band', type: 'rect', x: 0, y: 0, w: W, h: BAND_H, box: { background: fill } },
      {
        id: 'logo',
        type: 'logo',
        x: M,
        y: STACK_Y,
        w: CHIP_W,
        h: CHIP_H,
        align: 'center',
        box: { background: '#ffffff', radius: RADIUS, padding: CHIP_PAD },
        // Without a logo: the name as a wordmark, its line box the chip's inner height so one line sits centred. Names
        // up to about 23 characters fit; a longer one takes a second line, growing the chip inside the band (the
        // parties and the table then move down with it).
        fallbackStyle: { fontSize: 11, bold: true, color: 'text', lineHeight: (CHIP_H - 2 * CHIP_PAD) / 11 },
      },
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: R - 240, y: STACK_Y, w: 240, h: TITLE_H, style: { fontSize: 24, bold: true, color: ink, align: 'right', uppercase: true } },
      { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'value', x: R - 240, y: STACK_Y + TITLE_H, w: 240, h: NUMBER_H, style: { fontSize: 11, color: ink, align: 'right' } },
      { id: 'amountDue', type: 'field', field: 'balanceDue', layout: 'stacked', x: R - 240, y: DUE_Y, w: 240, h: DUE_H, label: { color: ink }, style: { fontSize: 14, bold: true, color: ink, align: 'right' } },

      { id: 'seller', type: 'seller', x: M, y: PARTY_Y, w: SELLER_W, h: PARTY_H, label },
      { id: 'billTo', type: 'billTo', x: BILL_X, y: PARTY_Y, w: BILL_W, h: BILL_H, label },
      { id: 'shipTo', type: 'shipTo', x: BILL_X, y: SHIP_Y, w: BILL_W, h: SHIP_H, label },
      { id: 'issueDate', type: 'field', field: 'issueDate', layout: 'inline', x: RX, y: FACT_Y, w: RW, h: 12, ...fact },
      { id: 'dueDate', type: 'field', field: 'dueDate', layout: 'inline', x: RX, y: FACT_Y + ROW, w: RW, h: 12, ...fact },
      { id: 'reference', type: 'field', field: 'reference', layout: 'inline', x: RX, y: FACT_Y + 2 * ROW, w: RW, h: 12, ...fact },

      {
        id: 'items',
        type: 'lineItems',
        x: M,
        y: TABLE_Y,
        w: CW,
        h: TABLE_H,
        columns,
        header: { background: fill, color: ink, uppercase: true, fontSize: 7.5 },
        zebra,
        rowRule: '#ffffff',
      },

      { id: 'payment', type: 'payment', x: M, y: CLOSE_Y, w: LW, h: CLOSE_H, label, box: { background: wash, padding: 10, radius: RADIUS } },
      { id: 'totals', type: 'totals', x: RX, y: CLOSE_Y, w: RW, h: CLOSE_H, total: { background: fill, color: ink, rule: fill } },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', layout: 'inline', x: RX, y: SUPPLY_Y, w: RW, h: SLOT_H, ...fact },
      { id: 'legal', type: 'legal', x: M, y: LEGAL_Y, w: CW, h: SLOT_H, style: { fontSize: 9 } },
      { id: 'notes', type: 'notes', x: M, y: AFTER_Y, w: LW, h: 36, label },
      { id: 'terms', type: 'terms', x: RX, y: AFTER_Y, w: RW, h: 36, label, style: small },

      { id: 'rule', type: 'line', x: M, y: RULE_Y, w: CW, h: 4, everyPage: true, color: ruleColor, thickness: 1.5 },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: CW - PAGE_W - REF_W - 8, h: 10, everyPage: true, style: small },
      {
        id: 'footerNumber',
        type: 'field',
        field: 'invoiceNumber',
        layout: 'value',
        x: R - PAGE_W - REF_W,
        y: FOOT_Y,
        w: REF_W,
        h: 10,
        everyPage: true,
        style: { ...small, align: 'right' },
      },
      { id: 'page', type: 'pageNumber', x: R - PAGE_W, y: FOOT_Y, w: PAGE_W, h: 10, everyPage: true, style: { ...small, align: 'right' } },
    ],
    { top: 48, bottom: BOTTOM },
  );
}
