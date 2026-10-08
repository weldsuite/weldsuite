/**
 * Check printing: the amount in words, the MICR E-13B line for blank check
 * stock, the fractional routing number, check numbering, and layout data
 * (field positions in points) for Letter stock: a check with voucher stubs, or
 * three checks per page. The platform renders the layouts with jsPDF and a
 * MICR font; nothing here draws.
 *
 * Void and reprint rules (data level, enforced by the books-api check service):
 * - Check numbers only go forward. A number is assigned when the check prints
 *   (see `nextCheckNumbers`) and is never reused, so a gap is always a check
 *   that exists, printed or voided.
 * - Voiding keeps the check row and its number, reverses the payment and
 *   reopens the bill. It never deletes.
 * - A reprint (paper jam, misprint, lost check) voids the old check and prints
 *   a new payment under the next number; the old number stays on the register
 *   as void and goes into the Positive Pay file as a void.
 * - A check can only be voided in an open period and before it clears.
 *
 * MICR positions follow ANSI X9.100-20 (8 characters per inch, position 1 at
 * 5/16 inch from the right edge); they are not from the research and must be
 * verified with a MICR gauge, which is what the alignment offsets are for.
 */

import { abaChecksumValid } from './nacha';

// ---------------------------------------------------------------------------
// Amount in words

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion'];

/** Largest amount a check can say in words: just under one trillion dollars. */
export const CHECK_MAX_AMOUNT = 999_999_999_999.99;

function underThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 20) parts.push(ONES[rest] as string);
    else {
      const tens = TENS[Math.floor(rest / 10)] as string;
      const ones = rest % 10;
      parts.push(ones > 0 ? `${tens}-${ONES[ones]}` : tens);
    }
  }
  return parts.join(' ');
}

function wholeNumberInWords(n: number): string {
  if (n === 0) return 'zero';
  const groups: string[] = [];
  let remaining = n;
  for (let scale = 0; remaining > 0; scale++) {
    const group = remaining % 1000;
    if (group > 0) groups.unshift(`${underThousand(group)}${scale > 0 ? ` ${SCALES[scale]}` : ''}`);
    remaining = Math.floor(remaining / 1000);
  }
  return groups.join(' ');
}

/**
 * The legal line of a check: "One thousand two hundred thirty-four and
 * 56/100". Cents are a fraction over 100; `currencyWord` adds " dollars".
 * Throws a RangeError for a negative, non-finite or too large amount.
 */
export function amountInWords(amount: number, options: { currencyWord?: boolean } = {}): string {
  if (!Number.isFinite(amount) || amount < 0 || amount > CHECK_MAX_AMOUNT) {
    throw new RangeError(`A check amount is between 0 and ${CHECK_MAX_AMOUNT}`);
  }
  const totalCents = Math.round(amount * 100);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  const words = wholeNumberInWords(dollars);
  const text = `${words.charAt(0).toUpperCase()}${words.slice(1)} and ${String(cents).padStart(2, '0')}/100`;
  return options.currencyWord ? `${text} dollars` : text;
}

/** The numeric amount box: "$**1,234.56" (the stars stop anyone writing digits in front). */
export function courtesyAmount(amount: number, options: { symbol?: boolean; protect?: number } = {}): string {
  if (!Number.isFinite(amount) || amount < 0 || amount > CHECK_MAX_AMOUNT) {
    throw new RangeError(`A check amount is between 0 and ${CHECK_MAX_AMOUNT}`);
  }
  const text = (Math.round(amount * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${options.symbol === false ? '' : '$'}${'*'.repeat(options.protect ?? 2)}${text}`;
}

// ---------------------------------------------------------------------------
// MICR E-13B

/** The four E-13B symbols (Unicode "OCR" block). */
export const MICR_SYMBOLS = {
  /** U+2446, brackets the routing (transit) number. */
  transit: '⑆',
  /** U+2447, brackets the amount the bank encodes. */
  amount: '⑇',
  /** U+2448, ends the account (on-us) field and brackets the auxiliary on-us field. */
  onUs: '⑈',
  /** U+2449, stands for a hyphen in an account number. */
  dash: '⑉',
} as const;

export interface MicrInput {
  routingNumber: string;
  accountNumber: string;
  checkNumber: string | number;
  /** `business`: check number in the auxiliary on-us field, left of the routing number. `personal`: after the account. */
  layout?: 'business' | 'personal';
  /** Check numbers are zero-padded to this many digits. Default 6. */
  checkNumberWidth?: number;
}

export interface MicrFields {
  /** Business checks only: the check number between on-us symbols. */
  auxOnUs: string;
  /** The routing number between transit symbols. */
  transit: string;
  /** The account number and its closing on-us symbol (plus the check number on a personal check). */
  onUs: string;
}

const MICR_ACCOUNT_MAX = 18;
const MICR_CHECK_NUMBER_MAX = 12;

/** Problems with the values a MICR line is made of; an empty list means the line can be built. */
export function validateMicrInput(input: MicrInput): string[] {
  const problems: string[] = [];
  if (!/^\d{9}$/.test(input.routingNumber)) problems.push('The routing number must be 9 digits');
  else if (!abaChecksumValid(input.routingNumber)) problems.push('The routing number fails the ABA checksum');
  const account = input.accountNumber.replace(/\s/g, '');
  if (!/^[0-9-]+$/.test(account) || !/\d/.test(account)) problems.push('The account number may only hold digits and hyphens');
  else if (account.length > MICR_ACCOUNT_MAX) problems.push(`The account number is longer than ${MICR_ACCOUNT_MAX} characters`);
  const check = String(input.checkNumber);
  if (!/^\d+$/.test(check)) problems.push('The check number must be digits');
  else if (check.length > MICR_CHECK_NUMBER_MAX) problems.push(`The check number is longer than ${MICR_CHECK_NUMBER_MAX} digits`);
  return problems;
}

/** The pieces of the MICR line, one per field, so a renderer can place each at its own position. */
export function buildMicrFields(input: MicrInput): MicrFields {
  const problems = validateMicrInput(input);
  if (problems.length > 0) throw new RangeError(problems.join('; '));
  const account = input.accountNumber.replace(/\s/g, '').replace(/-/g, MICR_SYMBOLS.dash);
  const check = String(input.checkNumber).padStart(input.checkNumberWidth ?? 6, '0');
  const transit = `${MICR_SYMBOLS.transit}${input.routingNumber}${MICR_SYMBOLS.transit}`;
  if ((input.layout ?? 'business') === 'personal') {
    return { auxOnUs: '', transit, onUs: `${account}${MICR_SYMBOLS.onUs} ${check}` };
  }
  return { auxOnUs: `${MICR_SYMBOLS.onUs}${check}${MICR_SYMBOLS.onUs}`, transit, onUs: `${account}${MICR_SYMBOLS.onUs}` };
}

/**
 * The whole MICR line as one string, fields separated by a space:
 * business `⑈000123⑈ ⑆021000021⑆ 123456789⑈`, personal `⑆021000021⑆ 123456789⑈ 000123`.
 * The amount field is left empty: the bank encodes it. Throws a RangeError for
 * an invalid routing number, account or check number.
 */
export function buildMicrLine(input: MicrInput): string {
  const fields = buildMicrFields(input);
  return [fields.auxOnUs, fields.transit, fields.onUs].filter((part) => part.length > 0).join(' ');
}

/**
 * Maps the four E-13B symbols to the letters common MICR fonts use for them
 * (A transit, B amount, C on-us, D dash, the GnuMICR convention), for fonts
 * that do not carry the Unicode symbols. Check which your font uses.
 */
export function micrToFontLetters(text: string): string {
  return text
    .replaceAll(MICR_SYMBOLS.transit, 'A')
    .replaceAll(MICR_SYMBOLS.amount, 'B')
    .replaceAll(MICR_SYMBOLS.onUs, 'C')
    .replaceAll(MICR_SYMBOLS.dash, 'D');
}

/**
 * The fractional routing number printed in a check's top corner, as
 * "numerator/denominator": the denominator is the first four digits of the
 * routing number; the numerator (city or state code, a hyphen and the bank's
 * number, e.g. "90-7162") is assigned by the bank and cannot be derived, so
 * it comes from the bank account's settings. Returns null without a numerator.
 */
export function fractionalRouting(routingNumber: string, numerator: string | null | undefined): string | null {
  if (!numerator) return null;
  if (!/^\d{9}$/.test(routingNumber)) throw new RangeError('The routing number must be 9 digits');
  if (!/^\d{1,2}-\d{1,4}$/.test(numerator)) throw new RangeError('The numerator looks like 90-7162');
  return `${numerator}/${routingNumber.slice(0, 4)}`;
}

/** The denominator of the fractional routing number: the first four digits. */
export function fractionalDenominator(routingNumber: string): string {
  if (!/^\d{9}$/.test(routingNumber)) throw new RangeError('The routing number must be 9 digits');
  return routingNumber.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Numbering

/** The next `count` check numbers from `start`, in order. */
export function nextCheckNumbers(start: number, count: number): number[] {
  if (!Number.isInteger(start) || start < 0) throw new RangeError('The first check number must be a whole number of 0 or more');
  if (!Number.isInteger(count) || count < 0 || count > 10_000) throw new RangeError('The count must be a whole number between 0 and 10,000');
  return Array.from({ length: count }, (_, i) => start + i);
}

export function formatCheckNumber(number: number, width = 6): string {
  return String(number).padStart(width, '0');
}

// ---------------------------------------------------------------------------
// Layouts

export type CheckLayoutId = 'voucher_top' | 'voucher_middle' | 'voucher_bottom' | 'three_per_page';

export const CHECK_LAYOUTS: ReadonlyArray<{ id: CheckLayoutId; label: string; description: string }> = [
  { id: 'voucher_top', label: 'Check on top, two stubs', description: 'One check per Letter page with the check at the top and two voucher stubs below.' },
  { id: 'voucher_middle', label: 'Check in the middle, two stubs', description: 'One check per Letter page with a stub above and below the check.' },
  { id: 'voucher_bottom', label: 'Check at the bottom, two stubs', description: 'One check per Letter page with two stubs above the check.' },
  { id: 'three_per_page', label: 'Three checks per page', description: 'Three checks per Letter page, without stubs.' },
];

export function isCheckLayoutId(value: unknown): value is CheckLayoutId {
  return CHECK_LAYOUTS.some((layout) => layout.id === value);
}

/** US Letter in points (1/72 inch). Coordinates start top-left and grow downwards, as in jsPDF. */
export const LETTER_PAGE = { width: 612, height: 792 } as const;

/** A voucher check's face is 3.5 inch, its two stubs 3.75 inch; three checks per page are 3 2/3 inch. */
export const VOUCHER_FACE_HEIGHT = 252;
export const VOUCHER_STUB_HEIGHT = 270;
export const THREE_UP_FACE_HEIGHT = 264;

/** Positions of the MICR line on a check (ANSI X9.100-20). */
export const MICR_SPEC = {
  fontSize: 12,
  /** 8 characters per inch. */
  pitch: 9,
  /** Position 1 starts 5/16 inch from the right edge. */
  rightMargin: 22.5,
  /** Characters sit 3/16 inch above the bottom edge. */
  baselineFromBottom: 13.5,
  /** Positions counted from the right edge, inclusive. */
  positions: {
    amount: [1, 14],
    onUs: [14, 32],
    transit: [33, 43],
    auxOnUs: [45, 64],
  },
} as const;

export type FontName = 'helvetica' | 'courier' | 'micr';

export interface TextBox {
  /** Left edge of the box. */
  x: number;
  /** Baseline of the first line. */
  y: number;
  width: number;
  align: 'left' | 'right' | 'center';
  fontSize: number;
  font: FontName;
  bold?: boolean;
  /** Distance between lines of a multi-line block. */
  lineHeight?: number;
}

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CheckFaceFields {
  payer: TextBox;
  bank: TextBox;
  checkNumber: TextBox;
  fractional: TextBox;
  dateLabel: TextBox;
  date: TextBox;
  payeeLabel: TextBox;
  payee: TextBox;
  /** Address lines under the payee name. */
  payeeAddress: TextBox;
  amountBox: { x: number; y: number; width: number; height: number };
  amount: TextBox;
  amountWords: TextBox;
  dollarsLabel: TextBox;
  memoLabel: TextBox;
  memo: TextBox;
  signatureLine: LineSegment;
  voidAfter: TextBox;
  /** Auxiliary on-us (business check number), transit and on-us fields of the MICR line, in the MICR font. */
  micrAuxOnUs: TextBox;
  micrTransit: TextBox;
  micrOnUs: TextBox;
}

export interface VoucherFields {
  payer: TextBox;
  title: TextBox;
  payee: TextBox;
  date: TextBox;
  checkNumber: TextBox;
  /** Columns of the invoice lines paid by the check. */
  table: {
    x: number;
    y: number;
    width: number;
    height: number;
    rowHeight: number;
    maxRows: number;
    fontSize: number;
    columns: ReadonlyArray<{ key: 'date' | 'reference' | 'description' | 'amount'; x: number; width: number; align: 'left' | 'right' }>;
  };
  totalLabel: TextBox;
  total: TextBox;
}

export interface CheckFace {
  /** Top edge of the check on the page. */
  top: number;
  height: number;
  fields: CheckFaceFields;
}

export interface CheckVoucher {
  top: number;
  height: number;
  fields: VoucherFields;
}

export interface CheckLayout {
  id: CheckLayoutId;
  label: string;
  page: { width: number; height: number };
  /** Checks on the page, top to bottom. */
  faces: CheckFace[];
  /** Stubs on the page, top to bottom (none for three per page). */
  vouchers: CheckVoucher[];
}

/** Calibration for a printer, in points: shifts every text on the page, and the MICR line separately. */
export interface CheckAlignment {
  dx?: number;
  dy?: number;
  micrDx?: number;
  micrDy?: number;
}

const MARGIN = 36;
const PAGE_WIDTH = LETTER_PAGE.width;

function text(x: number, y: number, width: number, fontSize: number, extra: Partial<TextBox> = {}): TextBox {
  return { x, y, width, align: 'left', fontSize, font: 'helvetica', ...extra };
}

function micrX(position: number): number {
  return PAGE_WIDTH - MICR_SPEC.rightMargin - position * MICR_SPEC.pitch;
}

function faceFields(top: number, height: number, align: Required<CheckAlignment>): CheckFaceFields {
  const dx = align.dx;
  const dy = top + align.dy;
  const micrBaseline = top + height - MICR_SPEC.baselineFromBottom + align.micrDy;
  const micrField = (near: number, far: number, textAlign: 'left' | 'right'): TextBox => ({
    // Positions count from the right edge, so the far end is the box's left edge.
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

function voucherFields(top: number, height: number, align: Required<CheckAlignment>): VoucherFields {
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

/**
 * Field positions for a Letter check layout, in points from the page's top-left
 * corner, ready for jsPDF. `alignment` shifts everything to calibrate a printer.
 */
export function getCheckLayout(id: CheckLayoutId, alignment: CheckAlignment = {}): CheckLayout {
  const align: Required<CheckAlignment> = { dx: 0, dy: 0, micrDx: 0, micrDy: 0, ...alignment };
  const meta = CHECK_LAYOUTS.find((layout) => layout.id === id);
  if (!meta) throw new RangeError(`Unknown check layout ${String(id)}`);

  const face = (top: number, height: number): CheckFace => ({ top, height, fields: faceFields(top, height, align) });
  const voucher = (top: number): CheckVoucher => ({
    top,
    height: VOUCHER_STUB_HEIGHT,
    fields: voucherFields(top, VOUCHER_STUB_HEIGHT, align),
  });

  const base = { id, label: meta.label, page: { width: LETTER_PAGE.width, height: LETTER_PAGE.height } };
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
