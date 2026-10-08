/**
 * Check layout geometry for the alignment test page: field positions in
 * points on US Letter, origin top-left, for each of the four check layouts.
 *
 * Mirrors `getCheckLayout` in `@weldsuite/books-domain/us-compliance/checks`
 * (the platform doesn't import the domain package). Real checks are always
 * printed from the layout the server sends with the check data, so this copy
 * only draws the test page; `check-layout.test.ts` compares it with the
 * domain's layouts so the two cannot drift apart unnoticed.
 */
import type {
  CheckAlignment,
  CheckFace,
  CheckFaceFields,
  CheckLayout,
  CheckLayoutId,
  CheckVoucher,
  TextBox,
  VoucherFields,
} from '@/lib/api/domains/weldbooks-payment-runs';

export const CHECK_LAYOUT_IDS: readonly CheckLayoutId[] = ['voucher_top', 'voucher_middle', 'voucher_bottom', 'three_per_page'];

const LETTER_PAGE = { width: 612, height: 792 } as const;
const VOUCHER_FACE_HEIGHT = 252;
const VOUCHER_STUB_HEIGHT = 270;
const THREE_UP_FACE_HEIGHT = 264;

const MICR_SPEC = {
  fontSize: 12,
  pitch: 9,
  rightMargin: 22.5,
  baselineFromBottom: 13.5,
  positions: {
    onUs: [14, 32],
    transit: [33, 43],
    auxOnUs: [45, 64],
  },
} as const;

const LAYOUT_LABELS: Record<CheckLayoutId, string> = {
  voucher_top: 'Check on top, two stubs',
  voucher_middle: 'Check in the middle, two stubs',
  voucher_bottom: 'Check at the bottom, two stubs',
  three_per_page: 'Three checks per page',
};

const MARGIN = 36;
const PAGE_WIDTH = LETTER_PAGE.width;

type FullAlignment = Required<CheckAlignment>;

function text(x: number, y: number, width: number, fontSize: number, extra: Partial<TextBox> = {}): TextBox {
  return { x, y, width, align: 'left', fontSize, font: 'helvetica', ...extra };
}

function micrX(position: number): number {
  return PAGE_WIDTH - MICR_SPEC.rightMargin - position * MICR_SPEC.pitch;
}

function faceFields(top: number, height: number, align: FullAlignment): CheckFaceFields {
  const dx = align.dx;
  const dy = top + align.dy;
  const micrBaseline = top + height - MICR_SPEC.baselineFromBottom + align.micrDy;
  const micrField = (near: number, far: number, textAlign: 'left' | 'right'): TextBox => ({
    x: micrX(far) + align.micrDx,
    y: micrBaseline,
    width: (far - near + 1) * MICR_SPEC.pitch,
    align: textAlign,
    fontSize: MICR_SPEC.fontSize,
    font: 'micr',
  });
  const signatureY = dy + height - 66;

  return {
    payer: text(MARGIN + dx, dy + 34, 250, 10, { bold: true, lineHeight: 12 }),
    bank: text(300 + dx, dy + 34, 170, 9, { align: 'center', lineHeight: 11 }),
    checkNumber: text(476 + dx, dy + 30, 100, 11, { align: 'right', bold: true }),
    fractional: text(476 + dx, dy + 18, 100, 7, { align: 'right' }),
    dateLabel: text(440 + dx, dy + 88, 34, 6.5),
    date: text(476 + dx, dy + 88, 100, 10, { align: 'right' }),
    payeeLabel: text(MARGIN + dx, dy + 118, 60, 6.5),
    payee: text(96 + dx, dy + 118, 360, 10, { bold: true }),
    payeeAddress: text(96 + dx, dy + 130, 360, 8, { lineHeight: 9 }),
    amountBox: { x: 470 + dx, y: dy + 104, width: 106, height: 20 },
    amount: text(474 + dx, dy + 118, 98, 11, { align: 'right', bold: true }),
    amountWords: text(MARGIN + dx, dy + 160, 456, 10),
    dollarsLabel: text(500 + dx, dy + 160, 76, 7, { align: 'right' }),
    memoLabel: text(MARGIN + dx, signatureY - 2, 30, 6.5),
    memo: text(68 + dx, signatureY - 2, 230, 9),
    signatureLine: { x1: 340 + dx, y1: signatureY, x2: 576 + dx, y2: signatureY },
    voidAfter: text(340 + dx, signatureY + 10, 236, 6.5, { align: 'center' }),
    micrAuxOnUs: micrField(...MICR_SPEC.positions.auxOnUs, 'right'),
    micrTransit: micrField(...MICR_SPEC.positions.transit, 'left'),
    micrOnUs: micrField(...MICR_SPEC.positions.onUs, 'right'),
  };
}

function voucherFields(top: number, height: number, align: FullAlignment): VoucherFields {
  const dx = align.dx;
  const dy = top + align.dy;
  const rowHeight = 12;
  const tableTop = dy + 76;
  const tableHeight = height - 76 - 44;
  return {
    payer: text(MARGIN + dx, dy + 26, 300, 9, { bold: true }),
    title: text(MARGIN + dx, dy + 40, 200, 7),
    payee: text(MARGIN + dx, dy + 58, 330, 10, { bold: true }),
    date: text(380 + dx, dy + 58, 90, 9, { align: 'right' }),
    checkNumber: text(476 + dx, dy + 58, 100, 10, { align: 'right', bold: true }),
    table: {
      x: MARGIN + dx,
      y: tableTop,
      width: 540,
      height: tableHeight,
      rowHeight,
      maxRows: Math.floor(tableHeight / rowHeight),
      fontSize: 8,
      columns: [
        { key: 'date', x: MARGIN + dx, width: 72, align: 'left' },
        { key: 'reference', x: 112 + dx, width: 200, align: 'left' },
        { key: 'description', x: 318 + dx, width: 152, align: 'left' },
        { key: 'amount', x: 476 + dx, width: 100, align: 'right' },
      ],
    },
    totalLabel: text(400 + dx, dy + height - 24, 70, 8, { align: 'right', bold: true }),
    total: text(476 + dx, dy + height - 24, 100, 10, { align: 'right', bold: true }),
  };
}

/** Field positions of a layout, shifted by the printer calibration `alignment` (points). */
export function getCheckLayout(id: CheckLayoutId, alignment: CheckAlignment = {}): CheckLayout {
  const align: FullAlignment = { dx: 0, dy: 0, micrDx: 0, micrDy: 0, ...alignment };
  const face = (top: number, height: number): CheckFace => ({ top, height, fields: faceFields(top, height, align) });
  const voucher = (top: number): CheckVoucher => ({
    top,
    height: VOUCHER_STUB_HEIGHT,
    fields: voucherFields(top, VOUCHER_STUB_HEIGHT, align),
  });

  const base = { id, label: LAYOUT_LABELS[id], page: { width: LETTER_PAGE.width, height: LETTER_PAGE.height } };
  switch (id) {
    case 'voucher_top':
      return { ...base, faces: [face(0, VOUCHER_FACE_HEIGHT)], vouchers: [voucher(VOUCHER_FACE_HEIGHT), voucher(VOUCHER_FACE_HEIGHT + VOUCHER_STUB_HEIGHT)] };
    case 'voucher_middle':
      return { ...base, faces: [face(VOUCHER_STUB_HEIGHT, VOUCHER_FACE_HEIGHT)], vouchers: [voucher(0), voucher(VOUCHER_STUB_HEIGHT + VOUCHER_FACE_HEIGHT)] };
    case 'voucher_bottom':
      return { ...base, faces: [face(2 * VOUCHER_STUB_HEIGHT, VOUCHER_FACE_HEIGHT)], vouchers: [voucher(0), voucher(VOUCHER_STUB_HEIGHT)] };
    case 'three_per_page':
      return {
        ...base,
        faces: [0, 1, 2].map((slot) => face(slot * THREE_UP_FACE_HEIGHT, THREE_UP_FACE_HEIGHT)),
        vouchers: [],
      };
  }
}
