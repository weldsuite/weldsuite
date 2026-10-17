/**
 * "Letterhead": a business letter for window envelopes. On A4 it follows DIN 5008 form B (address field
 * 85 x 45 mm at 20 mm / 45 mm with a one-line return address, information block at 125 mm, fold and hole
 * marks); on US Letter the address sits in the window of a #10 envelope. Logo top right, the invoice as the
 * letter's subject, and the company's registration, bank and contact details in a column footer on every page.
 * The footer columns already carry the VAT and registration numbers, so the footer text works best as name and address.
 */
import { contrast, doc, legible, mix, page } from '../preset-kit';
import type { InvoiceTemplateDocument, LabelStyle, LineItemColumn, PaperSize, TemplateBlock, TemplateField } from '../schema';

const DEFAULT_ACCENT = '#1b4b5a';

const mm = (v: number) => (v * 72) / 25.4;
const inch = (v: number) => v * 72;
const up4 = (v: number) => Math.ceil(v / 4) * 4;
const down4 = (v: number) => Math.floor(v / 4) * 4;

export default function letterhead(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  const raw = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : DEFAULT_ACCENT;
  // The theme accent is the brand colour deepened until it reads on white (the engine also prints the balance row in
  // it). A brand that had to be deepened keeps its own colour in the rules only while it reads as a line (3:1);
  // a pale one meets the deepened ink halfway, so rules and text stay one hue.
  const ink = legible(raw);
  const rule = ink === raw ? 'accent' : contrast(raw, '#ffffff') >= 3 ? raw : mix(raw, ink, 0.5);
  const a4 = paperSize === 'a4';

  // Sheet geometry. A4: DIN 5008 form B, text at 25 mm (5 mm inside the address field at 20 mm). Letter: #10 window
  // at 7/8 in (4.5 x 1.125 in), text at 1 in, 3/4 in right margin. `win` is the window's top and height.
  const M = a4 ? mm(25) : inch(1);
  const R = W - (a4 ? mm(20) : inch(0.75));
  const CW = R - M;
  const win = a4 ? { y: mm(45), h: mm(45) } : { y: inch(2), h: inch(1.125) };
  const folds = a4 ? [mm(105), mm(210)] : [H / 3, (2 * H) / 3];
  const hole = a4 ? mm(148.5) : null;

  // Columns: the information block at 125 mm (A4), or 1/4 in right of the #10 window (Letter), sets the right column;
  // the address text runs 80 mm from the margin.
  const PAD = 4;
  const G = 16;
  const INFO_X = a4 ? mm(125) : inch(5.375) + 18;
  const INFO_W = R - INFO_X;
  const ADDR_W = mm(80);
  // The footer continues the page's two columns: the left column split in two, and the information column.
  const LEFT_W = INFO_X - G - M;
  const FOOT_COL = (LEFT_W - G) / 2;
  const footCol = [M, M + FOOT_COL + G, INFO_X];

  // Vertical rhythm: 12pt lines (9pt type), block spacing in 4pt steps.
  const LINE = 12;
  const LH = LINE / 9;
  const LOGO_Y = 44;
  const LOGO_H = 40;
  // A4: the return address takes the first 17.7 mm of the address field. Letter: it sits just above the window, so the
  // window shows only the recipient (6 lines) however the folded sheet settles in the envelope.
  const BILL_Y = up4(win.y + (a4 ? mm(17.7) : 8));
  const BILL_H = down4(win.y + win.h - BILL_Y);
  // The information block's rows line up with the address lines: the fourth row is level with the recipient's first.
  const INFO_Y = BILL_Y - 3 * LINE;
  // The 6.5pt return address shares the baseline of the second information row (a line box centres the glyphs of
  // Helvetica, ascent 0.718, 0.254 x size above the middle), with its hairline 3pt under the baseline. Its own line box
  // is 1.4 x its size (a phone stacks it as a three-line address), so it starts half the difference lower.
  const RETURN_SIZE = 6.5;
  const RETURN_LH = 1.4;
  const RETURN_Y = INFO_Y + LINE + (9 - RETURN_SIZE) * 0.254 + (LINE - RETURN_LH * RETURN_SIZE) / 2;
  const RULE_Y = INFO_Y + LINE + LINE / 2 + 9 * 0.254 + 3 - 1;
  const INFO_END = INFO_Y + 5 * LINE;
  // A white panel behind the information block: invisible on paper, it keeps the rows together on a phone (as a white
  // card, inset like any band). Tall enough that the phone reads it after the addresses beside it (its middle lies
  // below the bill-to's top), which is why it stays white: tinted, it would show an empty lower half under the rows
  // and cut through the ship-to.
  const INFO_BOX_Y = INFO_Y - 4;
  const INFO_BOX_H = Math.max(INFO_END + 4 - INFO_BOX_Y, 2 * (BILL_Y - INFO_BOX_Y) + 8);
  // A delivery address continues the information column on its 12pt grid in the place-of-supply row, which only
  // Indian GST invoices fill: one empty row under the reference (over the invisible panel; its middle stays below the
  // panel, so a phone still reads it after the information block).
  const SHIP_Y = INFO_Y + 5 * LINE;
  // On Letter the subject starts under the first fold (on A4 it already ends above it, as DIN 5008 places it).
  const TITLE_Y = up4(Math.max(win.y + win.h + 20, INFO_END + 16, a4 ? 0 : folds[0] + 8));
  const TITLE_H = 20;
  const TABLE_Y = TITLE_Y + TITLE_H + 16;
  const TABLE_H = 96;
  const CLOSE_Y = TABLE_Y + TABLE_H + 20;
  const PAYMENT_H = 56;
  const TOTALS_H = 64;
  // The letter column ends with the personal note under the payment instructions; the information column with the
  // totals, the legal notice and the terms in the smallest type. Each optional block is the last of its column (or
  // only 12pt tall), so an empty one never leaves a hole. Notes and terms start level, so their labels share a baseline
  // and so do their first lines (12pt pitch in both).
  const LEGAL_Y = CLOSE_Y - PAD + TOTALS_H;
  const LEGAL_H = 12;
  const NOTES_Y = LEGAL_Y + LEGAL_H + 8;
  const TERMS_Y = NOTES_Y;
  const TERMS_H = 52;
  // Footer: a rule opens it, then the running line, the invoice number (so a separated continuation page can still be
  // matched to its invoice) and the page number, then three columns of four lines on the page's 12pt grid: two
  // label/value pairs each, or (contact) a heading over the e-mail address, the phone and the website.
  const FOOT_LINE = 10;
  const FOOT_Y = H - 72;
  const FOOT_TEXT_Y = FOOT_Y - 20;
  const FOOT_RULE_Y = FOOT_TEXT_Y - 8;
  // The engine sets a label in a 1.3 x size line box and the value 2pt under it; a 10.9pt value box puts the value's
  // baseline exactly one line (12pt) under its label's, so the pairs keep an even pitch and a lone value line fits in.
  const FOOT_LABEL_BOX = 7 * 1.3;
  const FOOT_VALUE = 2 * LINE - FOOT_LABEL_BOX - 2 * 2;

  const columns: LineItemColumn[] = [
    { key: 'description', width: 50 },
    { key: 'quantity', width: 11 },
    { key: 'unitPrice', width: 15 },
    { key: 'taxRate', width: 9 },
    { key: 'amount', width: 15 },
  ];

  // Labels are muted and sentence case. Inline labels (information block) are regular, as the engine sets the totals
  // labels; a label over its section (payment, notes, terms, delivery address, footer pairs) is bold, like the table head.
  const label: LabelStyle = { uppercase: false, bold: false, color: 'muted', fontSize: 9 };
  const heading: LabelStyle = { ...label, bold: true };
  const body = { lineHeight: LH } as const;
  const info = { lineHeight: LH, align: 'right' } as const;
  const foot = { fontSize: 7, color: 'muted', lineHeight: FOOT_LINE / 7 } as const;
  const footValue = { ...foot, lineHeight: FOOT_VALUE / 7 } as const;
  const footLabel: LabelStyle = { ...heading, fontSize: 7 };
  const footW = (i: number) => (i === 2 ? INFO_W : FOOT_COL);
  // A label over its value on lines `2 * row` and `2 * row + 1`, left-aligned (an inline label would push the value to
  // the column's right edge).
  const footPair = (id: string, field: TemplateField, i: number, row: number, text?: string): TemplateBlock => {
    const at = { x: footCol[i], y: FOOT_Y + 2 * row * LINE, w: footW(i), h: FOOT_LABEL_BOX + 2 + FOOT_VALUE };
    return { id, type: 'field', field, layout: 'stacked', ...at, everyPage: true, label: text ? { ...footLabel, text } : footLabel, style: footValue };
  };
  // A value alone on line `line` (0-3), on the baseline a pair would give it there.
  const footLine = (id: string, field: TemplateField, i: number, line: number): TemplateBlock => {
    const at = { x: footCol[i], y: FOOT_Y + line * LINE + (FOOT_LABEL_BOX - FOOT_VALUE) / 2, w: footW(i), h: FOOT_VALUE };
    return { id, type: 'field', field, layout: 'value', ...at, everyPage: true, style: footValue };
  };
  const mark = '#9aa0a8';

  const markBlocks: TemplateBlock[] = [
    ...folds.map((y, i): TemplateBlock => ({ id: `foldMark${i + 1}`, type: 'line', x: mm(5), y: y - 1, w: mm(5), h: 2, everyPage: true, color: mark, thickness: 0.5 })),
    ...(hole === null ? [] : [{ id: 'holeMark', type: 'line', x: mm(5), y: hole - 1, w: mm(8), h: 2, everyPage: true, color: mark, thickness: 0.5 } satisfies TemplateBlock]),
  ];

  return doc(
    paperSize,
    { font: 'helvetica', accent: ink, text: '#1d232c', muted: '#5b626e', fontSize: 9 },
    [
      // Letterhead: the logo, top right. The box reaches back to the second footer column so a company name set in
      // its place (no logo uploaded) stays on one line, and a very long one breaks into two inside the logo's height;
      // growing would push the information block and the address out of line with the window.
      { id: 'logo', type: 'logo', x: footCol[1], y: LOGO_Y, w: R - footCol[1], h: LOGO_H, align: 'right', fallbackStyle: { fontSize: 16, bold: true, align: 'right', lineHeight: LOGO_H / 32 } },

      // Address window: the return address on a hairline, then the recipient
      {
        id: 'seller',
        type: 'seller',
        x: M,
        y: RETURN_Y,
        w: ADDR_W,
        h: LINE,
        inline: true,
        boldName: false,
        showContact: false,
        showTaxIds: false,
        label: { show: false },
        style: { fontSize: RETURN_SIZE, color: 'muted', lineHeight: RETURN_LH },
      },
      // Like the table and footer rules it starts 4pt left of the text; it ends at 105 mm, the address field's edge.
      { id: 'returnRule', type: 'line', x: M - PAD, y: RULE_Y, w: ADDR_W + PAD, h: 2, color: mark, thickness: 0.5 },
      // Six address lines fit the window. The buyer's VAT number prints here too (the bill-to block has no switch to move
      // it to the information column), so a cross-border buyer with a c/o line would reach a seventh and grow past it.
      { id: 'billTo', type: 'billTo', x: M, y: BILL_Y, w: ADDR_W, h: BILL_H, showEmail: false, label: { show: false }, style: body },

      // Information block
      { id: 'infoBlock', type: 'rect', x: INFO_X - PAD, y: INFO_BOX_Y, w: INFO_W + 2 * PAD, h: INFO_BOX_H, box: { background: '#ffffff' } },
      { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'inline', x: INFO_X, y: INFO_Y, w: INFO_W, h: LINE, label, style: { ...info, bold: true } },
      { id: 'issueDate', type: 'field', field: 'issueDate', layout: 'inline', x: INFO_X, y: INFO_Y + LINE, w: INFO_W, h: LINE, label, style: info },
      { id: 'dueDate', type: 'field', field: 'dueDate', layout: 'inline', x: INFO_X, y: INFO_Y + 2 * LINE, w: INFO_W, h: LINE, label, style: info },
      { id: 'reference', type: 'field', field: 'reference', layout: 'inline', x: INFO_X, y: INFO_Y + 3 * LINE, w: INFO_W, h: LINE, label, style: info },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', layout: 'inline', x: INFO_X, y: INFO_Y + 4 * LINE, w: INFO_W, h: LINE, label, style: info },

      // Delivery address (when there is one) under the information block, designed down to the table so that a long
      // address fills its slot instead of pushing the table
      { id: 'shipTo', type: 'shipTo', x: INFO_X, y: SHIP_Y, w: INFO_W, h: TABLE_Y - 8 - SHIP_Y, label: heading, style: body },

      // Subject line
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: M, y: TITLE_Y, w: LEFT_W, h: TITLE_H, style: { fontSize: 16, bold: true, color: 'accent', lineHeight: TITLE_H / 16 } },

      {
        id: 'items',
        type: 'lineItems',
        x: M - PAD,
        y: TABLE_Y,
        w: CW + 2 * PAD,
        h: TABLE_H,
        columns,
        header: { uppercase: false, bold: true, fontSize: 9, color: 'muted', rule },
        rowRule: '#e3e5e9',
      },

      // Closing: payment and notes on the left; totals, the legal notice and the terms in the information column. A phone
      // reads the payment before the totals (one row, left to right); keeping them level on paper is worth that.
      { id: 'payment', type: 'payment', x: M, y: CLOSE_Y, w: LEFT_W, h: PAYMENT_H, label: heading, style: body },
      { id: 'notes', type: 'notes', x: M, y: NOTES_Y, w: LEFT_W, h: 36, label: heading, style: body },
      { id: 'totals', type: 'totals', x: INFO_X - PAD, y: CLOSE_Y - PAD, w: INFO_W + 2 * PAD, h: TOTALS_H, box: { padding: PAD }, style: body, total: { fontSize: 11, color: 'accent', rule } },
      { id: 'legal', type: 'legal', x: INFO_X, y: LEGAL_Y, w: INFO_W, h: LEGAL_H, style: body },
      { id: 'terms', type: 'terms', x: INFO_X, y: TERMS_Y, w: INFO_W, h: TERMS_H, label: heading, style: { fontSize: 8, color: 'muted', lineHeight: 1.5 } },

      // Footer on every page: a rule, the running line and page number, then registration, bank and contact details.
      // A grey hairline (the marks' colour) survives office printers whatever the brand colour.
      { id: 'footerRule', type: 'line', x: M - PAD, y: FOOT_RULE_Y - 1, w: CW + 2 * PAD, h: 2, everyPage: true, color: mark, thickness: 0.5 },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_TEXT_Y, w: LEFT_W, h: FOOT_LINE, everyPage: true, style: foot },
      { id: 'runningNumber', type: 'text', text: '{{title}} {{invoiceNumber}}', x: INFO_X, y: FOOT_TEXT_Y, w: INFO_W - 40, h: FOOT_LINE, everyPage: true, style: foot },
      { id: 'page', type: 'pageNumber', x: R - 32, y: FOOT_TEXT_Y, w: 32, h: FOOT_LINE, everyPage: true, style: { ...foot, align: 'right' } },
      footPair('footerVat', 'sellerTaxId', 0, 0),
      footPair('footerRegistration', 'sellerRegistrationId', 0, 1),
      footPair('footerIban', 'sellerIban', 1, 0, 'IBAN'),
      footPair('footerBic', 'sellerBic', 1, 1, 'BIC'),
      // Contact in the seller block's order. 'Contact' reads the same in English and Dutch (the engine has no translated
      // labels for these fields); a phone number and a web address need no label under it.
      footPair('footerEmail', 'sellerEmail', 2, 0, 'Contact'),
      footLine('footerPhone', 'sellerPhone', 2, 2),
      footLine('footerWebsite', 'sellerWebsite', 2, 3),

      // Fold marks (and the hole-punch mark on A4) at the left edge
      ...markBlocks,
    ],
    { top: 64, bottom: H - FOOT_RULE_Y + 8 },
  );
}
