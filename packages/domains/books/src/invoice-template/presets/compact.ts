/**
 * "Compact": a dense, efficient layout for invoices with many lines (wholesale, time sheets). A slim header that
 * also carries the seller's contact lines, the invoice facts in one tinted strip, the parties on three equal columns
 * (the seller's address and tax IDs in the middle one) and a tight zebra table that fits
 * far more rows per page than the other presets. Helvetica at 8pt throughout. The customer's address comes first, but on
 * the 36pt margin it is not measured for a window envelope (a DIN 5008 window starts 20mm from the edge).
 */
import { doc, legible, luminance, page, tint } from '../preset-kit';
import type { InvoiceTemplateDocument, LineItemColumn, PaperSize } from '../schema';

export default function compact(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  // A deep amber by default (5.4:1 on white), a hue none of the other presets start from.
  const brand = accent ?? '#9a5b13';
  // Text, rules and the balance row print in the accent, so a pale brand colour is deepened. Washes are the brand itself
  // lightened to a set luminance, so a pale brand colour still shows and a dark one stays light.
  const ink = legible(brand);
  const washTo = (target: number) => {
    let amount = 0.96;
    while (amount > 0.5 && luminance(tint(brand, amount)) > target) amount -= 0.01;
    return tint(brand, amount);
  };
  const wash = washTo(0.85);
  const zebra = washTo(0.93);
  const hairline = washTo(0.78);
  const washInk = legible(brand, wash);

  // Grid: text runs between M and R; fills (strip, table rows) hang out by the table's 4pt cell padding so cell text lines up.
  const M = 36;
  const R = W - M;
  const CW = R - M;
  const PAD = 4;
  const G = 16;
  const COL = (CW - 2 * G) / 3;
  const col = (i: number) => M + i * (COL + G);
  // The strip's six columns share the gutter, so every other one lines up with the three party columns.
  const COL6 = (CW - 5 * G) / 6;
  const col6 = (i: number) => M + i * (COL6 + G);

  // Vertical rhythm on a 4pt grid.
  const HEAD_Y = 36;
  const HEAD_H = 28;
  const STRIP_Y = HEAD_Y + HEAD_H + 8;
  const STRIP_H = 36;
  // A fact holds its label and one value line, centred in the strip.
  const FACT_Y = STRIP_Y + 8;
  const FACT_H = 28;
  const PARTY_Y = STRIP_Y + STRIP_H + 16;
  // A label and six lines set 8/10: the seller's name, address, a country line on a cross-border invoice and both tax IDs
  // (its email, phone and website are in the header), or the customer's name, address, country, email and VAT number.
  const PARTY_H = 72;
  const party = { lineHeight: 1.25 } as const;
  const TABLE_Y = PARTY_Y + PARTY_H + 16;
  const TABLE_H = 76;
  const CLOSE_Y = TABLE_Y + TABLE_H + 12;
  // The totals' own height (subtotal, tax, total), so the rule keeps the same distance under them when they grow: about
  // 13pt of air under a total row, the same as under the rule.
  const TOTALS_H = 50;
  const DIVIDER_Y = CLOSE_Y + TOTALS_H + 6;
  const SMALL_Y = DIVIDER_Y + 12;
  const SMALL_H = 60;
  // The footer line sits at H - 44, the line the other presets share, with room for a second line above the print limit.
  // The body stops 20pt above the footer rule, so a full page's last table rule never reads as a double rule with it.
  const FOOT_Y = H - 44;
  const FOOT_RULE_Y = FOOT_Y - 8;
  // The footer text, then the invoice number (so a loose continuation page can be matched to its invoice) and '2 / 3'.
  const PAGE_W = 28;
  const REF_W = 96;
  const FOOT_W = CW - PAGE_W - REF_W - G;

  const columns: LineItemColumn[] = [
    // Figures get their widest header (Dutch PRIJS PER STUK) or a six-figure amount plus the cell padding, the index three
    // digits (up to line 999); the rest goes to the description, so a typical 80-character line stays on one line.
    { key: 'index', width: 4.5, align: 'left' },
    { key: 'description', width: 55.5 },
    { key: 'quantity', width: 8.5 },
    { key: 'unitPrice', width: 12.5 },
    { key: 'taxRate', width: 6.5 },
    { key: 'amount', width: 12.5 },
  ];
  // One label family: 6.5pt bold capitals in the accent, deepened on the wash (strip labels and the table header).
  const factLabel = { color: washInk } as const;
  const label = { color: 'accent' } as const;
  const small = { fontSize: 7, color: 'muted' } as const;
  const rule = { color: hairline, thickness: 0.5 } as const;
  // The balance (the one figure the customer acts on) is set at 12pt in the tightest line box allowed; the 8pt fact values
  // get a looser one so their baselines meet it (a line box centres ascent + 0.21 descent: baseline = size x (lh / 2 + 0.254)).
  const BALANCE_TEXT = 12;
  const BALANCE_LH = 0.8;
  const fact = { fontSize: 8, lineHeight: 2 * ((BALANCE_TEXT * (BALANCE_LH / 2 + 0.254)) / 8 - 0.254) } as const;
  // Logo fallback and title are both set in the header's 28pt line box, the title's slightly tighter so its baseline lands
  // on the 13pt wordmark's (a line box centres ascent + 0.21 descent, so the baseline sits 0.254 x size below the middle).
  const LOGO_TEXT = 13;
  const TITLE_TEXT = 16;
  const titleLineHeight = (HEAD_H - (TITLE_TEXT - LOGO_TEXT) * 0.508) / TITLE_TEXT;
  const titleStyle = { fontSize: TITLE_TEXT, bold: true, color: 'accent', align: 'right', uppercase: true, lineHeight: titleLineHeight } as const;
  // The seller's email, phone and website head the From column (and the strip's due date) as three 7pt lines sharing the
  // header's 28pt, lowered so the middle one sits on the title's baseline. One block, so a phone reads them together.
  const CONTACT_Y = HEAD_Y + 0.254 * (LOGO_TEXT - small.fontSize);
  const contactStyle = { ...small, lineHeight: HEAD_H / 3 / small.fontSize } as const;

  return doc(
    paperSize,
    { font: 'helvetica', accent: ink, text: '#1a1a1f', muted: '#5b606b', fontSize: 8 },
    [
      // Header. The logo (or the name set as a wordmark) reaches half a gutter past the first column, clear of the contact lines.
      { id: 'logo', type: 'logo', x: M, y: HEAD_Y, w: COL + G / 2, h: HEAD_H, fallbackStyle: { fontSize: LOGO_TEXT, bold: true, lineHeight: HEAD_H / LOGO_TEXT } },
      {
        id: 'sellerContact',
        type: 'text',
        text: '{{sellerEmail}}\n{{sellerPhone}}\n{{sellerWebsite}}',
        x: col(1),
        y: CONTACT_Y,
        w: COL,
        h: HEAD_H,
        style: contactStyle,
      },
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: R - 200, y: HEAD_Y, w: 200, h: HEAD_H, style: titleStyle },

      // Facts strip
      { id: 'factStrip', type: 'rect', x: M - PAD, y: STRIP_Y, w: CW + 2 * PAD, h: STRIP_H, box: { background: wash } },
      // The number reaches half a gutter towards its neighbour (invoice numbers have no spaces to wrap on), the 12pt balance a
      // whole gutter, up to the place of supply's right edge.
      { id: 'number', type: 'field', field: 'invoiceNumber', x: col6(0), y: FACT_Y, w: COL6 + G / 2, h: FACT_H, label: factLabel, style: { ...fact, bold: true } },
      { id: 'issueDate', type: 'field', field: 'issueDate', x: col6(1), y: FACT_Y, w: COL6, h: FACT_H, label: factLabel, style: fact },
      { id: 'dueDate', type: 'field', field: 'dueDate', x: col6(2), y: FACT_Y, w: COL6, h: FACT_H, label: factLabel, style: fact },
      // A reference (PO numbers have no spaces either) gets the same half gutter: about 20 characters.
      { id: 'reference', type: 'field', field: 'reference', x: col6(3), y: FACT_Y, w: COL6 + G / 2, h: FACT_H, label: factLabel, style: fact },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', x: col6(4), y: FACT_Y, w: COL6, h: FACT_H, label: factLabel, style: fact },
      {
        id: 'amountDue',
        type: 'field',
        field: 'balanceDue',
        x: col6(5) - G,
        y: FACT_Y,
        w: COL6 + G,
        h: FACT_H,
        label: factLabel,
        style: { fontSize: BALANCE_TEXT, bold: true, color: washInk, align: 'right', lineHeight: BALANCE_LH },
      },

      // Parties: the customer first, where a left-window envelope shows the address.
      { id: 'billTo', type: 'billTo', x: col(0), y: PARTY_Y, w: COL, h: PARTY_H, label, style: party },
      { id: 'seller', type: 'seller', x: col(1), y: PARTY_Y, w: COL, h: PARTY_H, label, style: party, showContact: false },
      { id: 'shipTo', type: 'shipTo', x: col(2), y: PARTY_Y, w: COL, h: PARTY_H, label, style: party },

      {
        id: 'items',
        type: 'lineItems',
        x: M - PAD,
        y: TABLE_Y,
        w: CW + 2 * PAD,
        h: TABLE_H,
        columns,
        fontSize: 8,
        rowPadding: 3,
        header: { background: wash, color: washInk, rule: 'accent', fontSize: 6.5 },
        zebra,
        rowRule: hairline,
      },

      // Closing: the totals right under the table (also on a phone, which reads blocks row by row), then the small print
      // on the parties' three columns.
      { id: 'totals', type: 'totals', x: col(2), y: CLOSE_Y, w: COL, h: TOTALS_H, total: { fontSize: 9, color: 'accent', rule: 'accent' } },
      // Full-width rules span the same width as the table's rules and the washes.
      { id: 'closingRule', type: 'line', x: M - PAD, y: DIVIDER_Y - 1, w: CW + 2 * PAD, h: 2, ...rule },
      { id: 'notes', type: 'notes', x: col(0), y: SMALL_Y, w: COL, h: SMALL_H, label },
      { id: 'payment', type: 'payment', x: col(1), y: SMALL_Y, w: COL, h: SMALL_H, label },
      { id: 'terms', type: 'terms', x: col(2), y: SMALL_Y, w: COL, h: SMALL_H, style: small, label },
      // The VAT statement (reverse charge, exemption) gets its own line in the accent; it ends the flow, so an invoice
      // without one leaves nothing behind.
      { id: 'legal', type: 'legal', x: M, y: SMALL_Y + SMALL_H + 12, w: CW, h: 12, style: { color: 'accent' } },

      // Footer on every page
      { id: 'footerRule', type: 'line', x: M - PAD, y: FOOT_RULE_Y - 1, w: CW + 2 * PAD, h: 2, everyPage: true, ...rule },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: FOOT_W, h: 20, everyPage: true, style: small },
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
    { top: M, bottom: H - FOOT_RULE_Y + 20 },
  );
}
