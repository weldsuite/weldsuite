/**
 * "Statement": payment first. Under a quiet top row (logo, title, number) a pale summary panel answers
 * how much, by when, how and where to: the reader can pay without reading further.
 * Addresses, line items, totals and the small print follow on a three-column grid the panel shares.
 * Known trade-off: the panel takes the zone a window envelope shows, so the bill-to address sits below the window
 * (DIN 5008 / NL left window, US #10). For posted invoices, pick classic.
 */
import { DEFAULT_THEME, contrast, doc, legible, luminance, mix, page, readableOn, tint } from '../preset-kit';
import type { InvoiceTemplateDocument, LabelStyle, LineItemColumn, PaperSize } from '../schema';

const DEFAULT_ACCENT = '#176b45';

export default function statement(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  const raw = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : DEFAULT_ACCENT;

  // Grid: 48pt side margins, three equal columns with 20pt gutters; vertical rhythm in 4pt steps.
  const M = 48;
  const right = W - M;
  const CW = W - 2 * M;
  const GUTTER = 20;
  const COL = (CW - 2 * GUTTER) / 3;
  const col = (i: number) => M + i * (COL + GUTTER);

  // Colours: the panel is a pale wash of the accent, deepened until it shows on white; an accent too light
  // for that (white, lemon) washes its legible shade instead.
  const ink = legible(raw);
  const washes = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6].map((amount) => tint(raw, amount));
  const panelFill = washes.find((wash) => contrast(wash, '#ffffff') >= 1.1) ?? tint(ink, 0.88);
  const panelInk = legible(raw, panelFill);
  // A light brand (lemon, sand, lime) shaded until legible turns murky: its amounts (panel and balance row) print in the
  // text colour and the wash alone carries the brand. Mid-tone brands (orange-500, emerald-500) shade cleanly and keep it;
  // the 20pt bold amount then follows the accent token (3:1 is enough).
  const pale = luminance(raw) > 0.45;
  const themeAccent = pale ? DEFAULT_THEME.text : ink;
  const accentAmount = contrast(ink, panelFill) >= 3 ? 'accent' : panelInk;
  const amountInk = pale ? 'text' : accentAmount;
  const onPanel = readableOn(panelFill);
  const divider = mix(panelFill, ink, 0.22);
  // The total rule carries the accent. A pale one (lemon) would vanish on white: it takes a stronger shade of the wash.
  const totalRule = pale ? mix(panelFill, ink, 0.45) : 'accent';
  // A notch darker than the default grey, so captions keep 4.5:1 on the panel too.
  const muted = '#5f6672';

  const label: LabelStyle = { fontSize: 7.5, color: 'muted' };

  // Top row.
  const TOP = 48;
  const LOGO_H = 40;

  // Summary panel: the tint hangs PAD outside the content edges, so all three of its columns sit on the page grid
  // at full width (a six- or seven-figure amount, an unspaced 27-character IBAN). The free-text payment instructions
  // go under the due date, which has room for three lines (about 85 characters); the bank column keeps bank lines and payee.
  const PANEL_Y = TOP + LOGO_H + 24;
  const PAD = 16;
  const PANEL_H = 100;
  const inner = PANEL_Y + PAD;
  const innerH = PANEL_H - 2 * PAD;

  // Parties and details. The seller sets the row's height: name, two address lines, email, phone, website, CoC and
  // VAT number measure 106.35pt with the caption, and the box keeps one line more for the country a foreign buyer
  // sees (118.05pt). A delivery address (caption, name, two lines: 47.85pt) fits under a four-line bill-to, one 8pt
  // step down like the reference under the date.
  const ROW = PANEL_Y + PANEL_H + 24;
  const ROW_H = 120;
  const BILL_H = 60;
  const SHIP_Y = ROW + BILL_H + 8;
  const SHIP_H = 48;

  // Line items, 12pt under the row: a domestic seller stops a line short of its box, so its text keeps the 24pt the
  // panel keeps above the row. The designed height is the gap a three-line invoice shows under its last row. The table
  // hangs by its 4pt cell padding, so its text sits on the content edges and its rules overhang them like the panel does.
  const TABLE_Y = ROW + ROW_H + 12;
  const TABLE_H = 88;
  const AFTER = TABLE_Y + TABLE_H + 20;
  // Subtotal, VAT and Total measure 53.7pt.
  const TOTALS_H = 56;
  // One labelled line of notes (24.45pt) rounded to the grid, so a one-line note neither grows nor leaves room.
  const NOTES_H = 24;
  // The legal notice closes the left column (4pt while empty, it grows), so it never sits under a tall totals block
  // and costs nothing under the Total row. The terms run full width 16pt under the totals box (its Total row carries
  // 5pt of padding).
  const LEGAL_Y = AFTER + NOTES_H + 12;
  const TERMS_Y = AFTER + TOTALS_H + 16;
  const TERMS_H = 24;
  const SIDE_W = col(2) - GUTTER - M;

  const columns: LineItemColumn[] = [
    { key: 'description', width: 48 },
    { key: 'quantity', width: 10 },
    { key: 'unitPrice', width: 16 },
    { key: 'taxRate', width: 10 },
    { key: 'amount', width: 16 },
  ];

  const FOOT_Y = H - 44;

  return doc(
    paperSize,
    { accent: themeAccent, muted, fontSize: 9 },
    [
      // Top row.
      { id: 'logo', type: 'logo', x: M, y: TOP, w: 200, h: LOGO_H, fallbackStyle: { fontSize: 14, bold: true, color: 'text' } },
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: right - 240, y: TOP, w: 240, h: 20, style: { fontSize: 14, bold: true, color: 'text', align: 'right' } },
      // The number sits on the logo's foot, so the top row shares a top and a bottom line.
      { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'value', x: right - 240, y: TOP + LOGO_H - 12, w: 240, h: 12, style: { fontSize: 9, color: 'muted', align: 'right' } },

      // Summary panel.
      { id: 'summaryPanel', type: 'rect', x: M - PAD, y: PANEL_Y, w: CW + 2 * PAD, h: PANEL_H, box: { background: panelFill, radius: 6, borderWidth: 0.5, borderColor: divider } },
      { id: 'summaryDivider1', type: 'line', x: col(1) - GUTTER / 2 - 2, y: inner, w: 4, h: innerH, orientation: 'vertical', color: divider, thickness: 0.75 },
      { id: 'summaryDivider2', type: 'line', x: col(2) - GUTTER / 2 - 2, y: inner, w: 4, h: innerH, orientation: 'vertical', color: divider, thickness: 0.75 },
      // Tall to the panel's foot (nothing grows): the phone's reading order then groups the due date column with it.
      { id: 'balanceDue', type: 'field', field: 'balanceDue', x: col(0), y: inner, w: COL, h: PANEL_H - PAD, label, style: { fontSize: 20, bold: true, color: amountInk, lineHeight: 1.2 } },
      { id: 'dueDate', type: 'field', field: 'dueDate', x: col(1), y: inner, w: COL, h: 24, label, style: { fontSize: 9, bold: true, color: onPanel, lineHeight: 1.2 } },
      // When and how to pay belong together. No label: the panel already frames it.
      { id: 'paymentNote', type: 'payment', x: col(1), y: inner + 32, w: COL, h: innerH - 32, showBank: false, label: { show: false }, style: { color: onPanel, lineHeight: 1.25 } },
      // The payee is the line under the bank lines (label and two lines measure 35.25pt), so the payer has the name
      // Verification of Payee checks. Bank lines stay regular: bold widens an unspaced IBAN past the column.
      { id: 'payment', type: 'payment', x: col(2), y: inner, w: COL, h: 36, label, showInstructions: false, style: { color: onPanel, lineHeight: 1.25 } },
      { id: 'payee', type: 'field', field: 'sellerLegalName', layout: 'value', x: col(2), y: inner + 36, w: COL, h: 12, style: { color: onPanel, lineHeight: 1.25 } },

      // Parties and details, on the page grid.
      { id: 'billTo', type: 'billTo', x: col(0), y: ROW, w: COL, h: BILL_H, label },
      { id: 'shipTo', type: 'shipTo', x: col(0), y: SHIP_Y, w: COL, h: SHIP_H, label },
      { id: 'seller', type: 'seller', x: col(1), y: ROW, w: COL, h: ROW_H, label },
      { id: 'issueDate', type: 'field', field: 'issueDate', x: col(2), y: ROW, w: COL, h: 24, label },
      { id: 'reference', type: 'field', field: 'reference', x: col(2), y: ROW + 32, w: COL, h: 24, label },
      // GST only. Under the reference, where it fits at full size and moves nothing (the seller's column has no room
      // left); an invoice without a PO leaves a hole above it.
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', x: col(2), y: ROW + 64, w: COL, h: 24, label },

      {
        id: 'items',
        type: 'lineItems',
        x: M - 4,
        y: TABLE_Y,
        w: CW + 8,
        h: TABLE_H,
        columns,
        header: { color: 'muted', fontSize: 7.5, uppercase: true, rule: divider },
      },

      // After the table: the notes lead the left column beside the totals, the legal notice under them.
      // Totals end on the content edge, flush with the amounts; their total rule stops 4pt inside the hanging table rules.
      { id: 'notes', type: 'notes', x: M, y: AFTER, w: SIDE_W, h: NOTES_H, label },
      { id: 'totals', type: 'totals', x: col(2), y: AFTER, w: right - col(2), h: TOTALS_H, total: { fontSize: 11, rule: totalRule } },
      { id: 'legal', type: 'legal', x: M, y: LEGAL_Y, w: SIDE_W, h: 4 },
      { id: 'terms', type: 'terms', x: M, y: TERMS_Y, w: CW, h: TERMS_H, label, style: { fontSize: 7.5, color: 'muted' } },

      // Footer on every page; its rule hangs like the table rules. The invoice number identifies a loose continuation page.
      { id: 'footerRule', type: 'line', x: M - 4, y: FOOT_Y - 12, w: CW + 8, h: 2, everyPage: true, color: '#e2e4e8', thickness: 0.5 },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: CW - 208, h: 10, everyPage: true, style: { fontSize: 7.5, color: 'muted' } },
      { id: 'pageInvoiceNumber', type: 'field', field: 'invoiceNumber', layout: 'value', x: right - 200, y: FOOT_Y, w: 112, h: 10, everyPage: true, style: { fontSize: 7.5, color: 'muted', align: 'right' } },
      { id: 'page', type: 'pageNumber', x: right - 80, y: FOOT_Y, w: 80, h: 10, everyPage: true, style: { fontSize: 7.5, align: 'right' } },
    ],
    { top: 48, bottom: 68 },
  );
}
