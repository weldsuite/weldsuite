/**
 * "Classic": the fixed layout invoices had before templates existed. Logo left and the title right, the seller
 * beside the invoice facts and its registration numbers, the customer, a ruled table, notes beside the totals, then
 * payment and terms.
 * Helvetica 9pt, one accent for the title, the rules and the balance due.
 */
import { DEFAULT_THEME, contrast, doc, legible, page } from '../preset-kit';
import type { InvoiceTemplateDocument, LineItemColumn, PaperSize } from '../schema';

export default function classic(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  // The accent prints as text (title, balance due) and thin rules only, so a pale brand colour is deepened until it reads.
  const brand = accent ?? DEFAULT_THEME.accent;
  const ink = legible(brand);
  // The 1pt rules are decoration, not text: a pale brand colour keeps its own hue there. Normal accents stay on the token
  // so a later accent change in the designer carries over to the rules.
  const rule = contrast(brand, '#ffffff') < 3 ? brand : undefined;

  // Grid: text runs between M and R. The table hangs out by its 4pt cell padding so its text lines up with the rest; its
  // rules therefore end 4pt past the Total rule, which spans exactly the totals block (the engine has no rule outset).
  const M = 48;
  const R = W - M;
  const CW = R - M;
  const CELL = 4;
  const GUTTER = 24;
  const COL = (CW - GUTTER) / 2;
  const RX = M + COL + GUTTER;

  // Vertical rhythm on a 4pt grid: 32 after the masthead, 20 under the seller zone (its facts column ends 5pt above the
  // zone's edge, so this shows as the same ~25pt as the 24 under the customer), 20 from the table to its closing row and
  // from the totals box (which ends ~5pt under the Total line) to payment, 8 from notes to the legal notice, 16 from
  // payment to the terms.
  const TOP = 48;
  const LOGO_H = 40;
  // Caps labels sit in a shorter line than 9pt values: a value column beside a labelled block starts 1pt higher so the
  // first baselines line up (FROM with DATE, NOTES with Subtotal).
  const OPTICAL = 1;
  const PARTY_Y = TOP + LOGO_H + 32;
  // The seller prints its name, address, email, phone and website, plus a country line on a cross-border invoice: 7
  // lines under its label, 95pt. Its VAT and registration numbers join the facts column, which then also runs 6 rows of
  // 16pt, so both columns fill the same 96pt.
  const SELLER_H = 96;
  // Facts: date, due date, reference, place of supply, then the seller's VAT and registration numbers on the zone's last
  // two rows. Blocks never move up, so an empty field leaves its row blank: a missing reference or place of supply (the
  // common case) opens a gap between the invoice's facts and the seller's numbers, where a gap reads as intended. With a
  // place of supply (India) the column runs as one list ending in GSTIN and PAN.
  const META_ROW = 16;
  const BILL_Y = PARTY_Y + SELLER_H + 20;
  const BILL_H = 60;
  const TABLE_Y = BILL_Y + BILL_H + 24;
  const TABLE_H = 96;
  const CLOSE_Y = TABLE_Y + TABLE_H + 20;
  const TOTALS_H = 56;
  const NOTES_H = 28;
  // The legal notice sits in the free left column under the notes, beside the totals: an empty one (most invoices) costs
  // nothing, and a reverse-charge notice does not get squeezed between the totals and payment.
  const LEGAL_Y = CLOSE_Y + NOTES_H + 8;
  const PAYMENT_Y = CLOSE_Y - OPTICAL + TOTALS_H + 20;
  const PAYMENT_H = 52;
  const TERMS_Y = PAYMENT_Y + PAYMENT_H + 16;
  const FOOT_Y = H - 44;

  const label = { uppercase: true, fontSize: 7.5 };
  const columns: LineItemColumn[] = [
    { key: 'description', width: 49 },
    { key: 'quantity', width: 11 },
    { key: 'unitPrice', width: 16 },
    { key: 'taxRate', width: 9 },
    { key: 'amount', width: 15 },
  ];

  // The default muted grey is 4.4:1 on white; this one reads at 4.9:1 for the 7.5pt caps labels.
  const theme = { accent: ink, muted: '#6b7080' };
  // 64 at the bottom keeps a full page of rows at least 20pt clear of the footer.
  const margins = { top: 48, bottom: 64 };

  return doc(
    paperSize,
    theme,
    [
      { id: 'logo', type: 'logo', x: M, y: TOP, w: 200, h: LOGO_H, fallbackStyle: { fontSize: 16, bold: true, lineHeight: 1.57 } },
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: R - 240, y: TOP, w: 240, h: 24, style: { fontSize: 22, bold: true, color: 'accent', align: 'right', uppercase: true, lineHeight: 1 } },
      { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'value', x: R - 240, y: TOP + 31, w: 240, h: 16, style: { fontSize: 10, color: 'muted', align: 'right' } },
      { id: 'seller', type: 'seller', x: M, y: PARTY_Y, w: COL, h: SELLER_H, showTaxIds: false },
      { id: 'issueDate', type: 'field', field: 'issueDate', layout: 'inline', x: RX, y: PARTY_Y - OPTICAL, w: R - RX, h: META_ROW, label },
      { id: 'dueDate', type: 'field', field: 'dueDate', layout: 'inline', x: RX, y: PARTY_Y - OPTICAL + META_ROW, w: R - RX, h: META_ROW, label },
      { id: 'reference', type: 'field', field: 'reference', layout: 'inline', x: RX, y: PARTY_Y - OPTICAL + 2 * META_ROW, w: R - RX, h: META_ROW, label },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', layout: 'inline', x: RX, y: PARTY_Y - OPTICAL + 3 * META_ROW, w: R - RX, h: META_ROW, label },
      { id: 'sellerTaxId', type: 'field', field: 'sellerTaxId', layout: 'inline', x: RX, y: PARTY_Y - OPTICAL + 4 * META_ROW, w: R - RX, h: META_ROW, label },
      { id: 'sellerRegistrationId', type: 'field', field: 'sellerRegistrationId', layout: 'inline', x: RX, y: PARTY_Y - OPTICAL + 5 * META_ROW, w: R - RX, h: META_ROW, label },
      { id: 'billTo', type: 'billTo', x: M, y: BILL_Y, w: COL, h: BILL_H },
      { id: 'shipTo', type: 'shipTo', x: RX, y: BILL_Y, w: R - RX, h: BILL_H },
      { id: 'items', type: 'lineItems', x: M - CELL, y: TABLE_Y, w: CW + 2 * CELL, h: TABLE_H, columns, header: { fontSize: 7.5, ...(rule ? { rule } : {}) } },
      { id: 'notes', type: 'notes', x: M, y: CLOSE_Y, w: COL, h: NOTES_H },
      { id: 'totals', type: 'totals', x: RX, y: CLOSE_Y - OPTICAL, w: R - RX, h: TOTALS_H, ...(rule ? { total: { rule } } : {}) },
      { id: 'legal', type: 'legal', x: M, y: LEGAL_Y, w: COL, h: 4 },
      { id: 'payment', type: 'payment', x: M, y: PAYMENT_Y, w: CW, h: PAYMENT_H },
      { id: 'terms', type: 'terms', x: M, y: TERMS_Y, w: CW, h: 12, label: { show: false }, style: { fontSize: 8, color: 'muted' } },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: CW - 96, h: 12, everyPage: true, style: { fontSize: 8, color: 'muted' } },
      { id: 'page', type: 'pageNumber', x: R - 80, y: FOOT_Y, w: 80, h: 12, everyPage: true, style: { align: 'right' } },
    ],
    margins,
  );
}
