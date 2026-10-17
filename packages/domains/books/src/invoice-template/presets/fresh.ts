/**
 * "Fresh": a modern SaaS invoice. A thin accent bar tops every page; the logo and a large friendly title sit
 * left with the seller as a quiet letterhead on the right; the customer and the invoice facts follow in two
 * softly tinted rounded cards (ship-to and place-of-supply cards under them when there are any), the table has a light tinted
 * header and airy rows, and the totals close in a slightly deeper card with the grand total bold in the accent
 * under an accent rule. Helvetica throughout.
 */
import { doc, legible, luminance, page, shade, tint } from '../preset-kit';
import type { InvoiceTemplateDocument, LineItemColumn, PaperSize } from '../schema';

export default function fresh(paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const { W, H } = page(paperSize);
  const brand = accent ?? '#6d4aff';
  // Washes are the brand moved to a set luminance: lightened for most brands, deepened for one already paler than
  // the target, so the cards and rules show on white paper for any accent.
  const washTo = (target: number) => {
    if (luminance(brand) > target) {
      let amount = 0;
      while (amount < 0.6 && luminance(shade(brand, amount)) > target) amount += 0.02;
      return shade(brand, amount);
    }
    let amount = 0.97;
    while (amount > 0 && luminance(tint(brand, amount)) > target) amount -= 0.01;
    return tint(brand, amount);
  };
  const card = washTo(0.9);
  // The totals card is a step deeper so the invoice visibly ends there; muted text still reads at about 5:1 on it.
  const totalsCard = washTo(0.86);
  const rule = washTo(0.8);
  // The theme accent prints the column heads, the grand total and the balance on the cards, so it is deepened until it
  // reads on the deepest of them (and so on the paler cards and white too).
  const ink = legible(brand, totalsCard);
  // The bar follows the theme accent (and later accent changes) unless a pale brand had to be deepened for text;
  // a near-white brand is deepened so the bar still reads on white.
  const bar = luminance(brand) > 0.7 ? washTo(0.7) : ink === brand ? 'accent' : brand;

  // Grid: two halves with a 16pt gutter; cards fill a half and inset their text by the card padding. The 48pt margin and
  // 10pt padding put the bill-to text 58pt (20.5mm) in, clear of the edge of a left window envelope (DIN 5008, NL EA5/6).
  const M = 48;
  const R = W - M;
  const CW = R - M;
  const G = 16;
  const HALF = (CW - G) / 2;
  const RX = M + HALF + G;
  // Card text sits PAD inside the card edges. The table hangs its 4pt cell inset past the content edges, so its cell text
  // lines up with the title, logo, payment and terms on M (and the amounts on R) and the header band overhangs by 4pt.
  const PAD = 10;
  const cardBox = { background: card, radius: 8, padding: PAD };
  // Body text line box (9pt x 1.3): the fact rows are spaced in address lines so their values share baselines with them.
  const LINE = 9 * 1.3;

  // Vertical rhythm on a 4pt grid.
  const TOP = 40;
  const LOGO_H = 40;
  const TITLE_Y = TOP + LOGO_H + 24;
  const TITLE_H = 36;
  // The letterhead's eight lines (name, two address lines, email, phone, website, registration and VAT numbers) are led
  // at 1.4 so they run from the logo's top to the title's baseline; the box holds a ninth, the seller's country on a
  // cross-border invoice, so that one pushes nothing either.
  const SELLER_LINE = 1.4;
  const SELLER_H = 104;
  const CARD_Y = TITLE_Y + TITLE_H + 12;
  // Fits a business customer abroad, the six lines of a reverse-charge invoice (name, street, postcode and city, country,
  // email, VAT number), with even padding top and bottom, so the two cards stay one height.
  const CARD_H = 104;
  const FACT_H = 24;
  const FACT_W = (HALF - 2 * PAD - G) / 2;
  const FACT_X0 = RX + PAD;
  const FACT_X1 = FACT_X0 + FACT_W + G;
  // A field's value sits 2pt under its label, an address name 3pt: the 1pt drop puts both value rows on bill-to baselines
  // (the first on the customer name, the second on the sixth line), which spreads the facts over the card's full height.
  const FACT_Y0 = CARD_Y + PAD + 1;
  const FACT_Y1 = FACT_Y0 + 5 * LINE;
  // An optional row of cards under the first: ship-to left, place of supply right. Empty, a card paints nothing and keeps
  // its 4pt, so the cards-to-table gap (8 + 4 + 24) matches the table-to-closing gap; filled, the cards sit 8pt under the
  // first row like a stack and grow, pushing the table down, which then still starts 24pt under them.
  const EXTRA_Y = CARD_Y + CARD_H + 8;
  const EXTRA_H = 4;
  const TABLE_Y = EXTRA_Y + EXTRA_H + 24;
  const TABLE_H = 96;
  const CLOSE_Y = TABLE_Y + TABLE_H + 36;
  // Notes close the left column, so an invoice without notes leaves nothing behind (the engine keeps an empty block's height).
  const PAY_Y = CLOSE_Y;
  const PAY_H = 52;
  const TERMS_Y = PAY_Y + PAY_H + 16;
  const TERMS_H = 40;
  // Two lines of terms leave 4pt of their box free, so 12 more keeps the same 16pt of white above each caption.
  const NOTES_Y = TERMS_Y + TERMS_H + 12;
  const NOTES_H = 28;
  const TOTALS_H = 76;
  const LEGAL_Y = CLOSE_Y + TOTALS_H + 12;
  const FOOT_RULE_Y = H - 52;
  const FOOT_Y = H - 40;

  const columns: LineItemColumn[] = [
    { key: 'description', width: 48 },
    { key: 'quantity', width: 11 },
    { key: 'unitPrice', width: 15 },
    { key: 'taxRate', width: 10 },
    { key: 'amount', width: 16 },
  ];
  const small = { fontSize: 8, color: 'muted' } as const;
  const fact = (id: string, field: 'invoiceNumber' | 'issueDate' | 'dueDate' | 'reference', x: number, y: number) =>
    ({ id, type: 'field', field, x, y, w: FACT_W, h: FACT_H, style: field === 'invoiceNumber' ? { bold: true } : {} }) as const;

  return doc(
    paperSize,
    { font: 'helvetica', accent: ink, text: '#16161d', muted: '#5f6270', fontSize: 9 },
    [
      { id: 'topBar', type: 'rect', x: 0, y: 0, w: W, h: 6, everyPage: true, box: { background: bar } },

      // Header: logo and title left, the seller as a letterhead right
      { id: 'logo', type: 'logo', x: M, y: TOP, w: HALF, h: LOGO_H, fallbackStyle: { fontSize: 16, bold: true, lineHeight: LOGO_H / 16 } },
      { id: 'title', type: 'field', field: 'title', layout: 'value', x: M, y: TITLE_Y, w: HALF, h: TITLE_H, style: { fontSize: 26, bold: true, lineHeight: 1.2 } },
      { id: 'seller', type: 'seller', x: RX, y: TOP, w: HALF, h: SELLER_H, label: { show: false }, style: { ...small, align: 'right', lineHeight: SELLER_LINE } },

      // Cards: the customer left, the invoice facts right
      { id: 'billTo', type: 'billTo', x: M, y: CARD_Y, w: HALF, h: CARD_H, box: cardBox },
      { id: 'factsCard', type: 'rect', x: RX, y: CARD_Y, w: HALF, h: CARD_H, box: { background: card, radius: 8 } },
      fact('number', 'invoiceNumber', FACT_X0, FACT_Y0),
      fact('issueDate', 'issueDate', FACT_X1, FACT_Y0),
      fact('dueDate', 'dueDate', FACT_X0, FACT_Y1),
      fact('reference', 'reference', FACT_X1, FACT_Y1),
      { id: 'shipTo', type: 'shipTo', x: M, y: EXTRA_Y, w: HALF, h: EXTRA_H, box: cardBox },
      { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', x: RX, y: EXTRA_Y, w: HALF, h: EXTRA_H, box: cardBox },

      {
        id: 'items',
        type: 'lineItems',
        x: M - 4,
        y: TABLE_Y,
        w: CW + 8,
        h: TABLE_H,
        columns,
        rowPadding: 6,
        // Column heads match the block labels (7.5pt bold capitals) and take the accent on their tinted band.
        header: { background: card, color: 'accent', uppercase: true, fontSize: 7.5, rule: card },
        rowRule: rule,
      },

      // Closing: payment, terms and notes left; the totals card and any legal notice right
      { id: 'payment', type: 'payment', x: M, y: PAY_Y, w: HALF, h: PAY_H },
      {
        id: 'totals',
        type: 'totals',
        x: RX,
        y: CLOSE_Y,
        w: HALF,
        h: TOTALS_H,
        box: { ...cardBox, background: totalsCard },
        // No band behind the grand total: a band insets its figure, and every amount on the card should share one edge.
        // Only a step above the base size, so a balance due (base size, bold) under it still reads as the amount to pay.
        total: { fontSize: 12, color: 'accent', rule: 'accent' },
      },
      // Notices read as fine print under the totals card, in line with its text (the engine always sets them bold).
      { id: 'legal', type: 'legal', x: RX + PAD, y: LEGAL_Y, w: HALF - 2 * PAD, h: 4, style: { fontSize: 8, color: 'muted' } },
      { id: 'terms', type: 'terms', x: M, y: TERMS_Y, w: HALF, h: TERMS_H },
      { id: 'notes', type: 'notes', x: M, y: NOTES_Y, w: HALF, h: NOTES_H },

      // Footer on every page
      { id: 'footerRule', type: 'line', x: M, y: FOOT_RULE_Y - 1, w: CW, h: 2, everyPage: true, color: rule, thickness: 0.5 },
      { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: FOOT_Y, w: CW - 100, h: 12, everyPage: true, style: small },
      { id: 'page', type: 'pageNumber', x: R - 80, y: FOOT_Y, w: 80, h: 12, everyPage: true, style: { ...small, align: 'right' } },
    ],
    { top: TOP, bottom: H - FOOT_RULE_Y + 12 },
  );
}
