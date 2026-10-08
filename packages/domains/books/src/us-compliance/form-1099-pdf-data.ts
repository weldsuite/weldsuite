/**
 * Renderer-neutral layout data for substitute 1099-NEC and 1099-MISC
 * statements: Copy B (recipient, federal), Copy 1 (state tax department),
 * Copy 2 (recipient, state return) and Copy C (payer's records).
 *
 * The platform draws the PDF (jsPDF) from this: every field has a position and
 * size in points on a US Letter page (612 x 792, origin top-left, y grows
 * down), a printed label and the value to print. Copy A (the red scannable IRS
 * page) is never produced; IRIS takes the data instead.
 *
 * The recipient's TIN is only ever known here as its last four digits and is
 * printed truncated (`***-**-1234`, `**-***1234`), which the IRS allows on
 * recipient statements. The payer's TIN is printed in full. The instruction
 * paragraphs on Copy B paraphrase the IRS "Instructions for Recipient"; check
 * them against Pub 1179 before the first filing season.
 */

import { form1099Box, type Form1099BoxCode, type Form1099Type } from '../jurisdictions/us/form-1099';

export type Form1099Copy = 'B' | '1' | '2' | 'C';

export const FORM_1099_COPIES: readonly Form1099Copy[] = ['B', '1', '2', 'C'];

export const LETTER_PAGE = { width: 612, height: 792, unit: 'pt', origin: 'top-left' } as const;

export type PdfFieldKind = 'text' | 'amount' | 'tin' | 'checkbox';

export interface Form1099PdfField {
  id: string;
  /** Small printed caption of the box. */
  label: string;
  /** Text to print; empty for an empty box. Checkboxes are empty and use `checked`. */
  value: string;
  kind: PdfFieldKind;
  /** The box outline: left, top, width, height in points. */
  x: number;
  y: number;
  width: number;
  height: number;
  align: 'left' | 'right';
  multiline?: boolean;
  checked?: boolean;
  /** The 1099 box this field shows, when it is one. */
  box?: Form1099BoxCode;
}

export interface Form1099PdfTextBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  bold?: boolean;
  /** Paragraphs, drawn one under the other with a blank line between them when `paragraphGap` is set. */
  paragraphs: string[];
  paragraphGap?: number;
}

export interface Form1099PdfCopy {
  form: Form1099Type;
  copy: Form1099Copy;
  taxYear: number;
  page: typeof LETTER_PAGE;
  title: string;
  copyLabel: string;
  /** Label and value sizes in points. */
  labelFontSize: number;
  valueFontSize: number;
  fields: Form1099PdfField[];
  blocks: Form1099PdfTextBlock[];
  /** Footer line at the bottom of the page. */
  footer: string;
}

export interface Form1099PdfAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  country?: string | null;
}

export interface Form1099PdfInput {
  form: Form1099Type;
  taxYear: number;
  payer: {
    name: string;
    nameLine2?: string | null;
    address: Form1099PdfAddress;
    phone?: string | null;
    tinType: 'ein' | 'ssn';
    /** Full TIN: the payer's own number is printed in full. */
    tin: string;
  };
  recipient: {
    name: string;
    /** Business or DBA name, printed under the name. */
    businessName?: string | null;
    address: Form1099PdfAddress;
    tinType: 'ein' | 'ssn' | 'itin';
    /** Last four digits; the full TIN never reaches this function. */
    tinLast4: string;
    accountNumber?: string | null;
  };
  boxes: Partial<Record<Form1099BoxCode, number>>;
  directSales?: boolean;
  fatca?: boolean;
  corrected?: boolean;
  states?: Array<{ code: string; payerStateNumber?: string | null; withheld?: number | null; income?: number | null }>;
  /** Defaults to Copy B, 1, 2 and C. */
  copies?: Form1099Copy[];
}

// TIN formatting

/** `***-**-1234` for an SSN, ITIN or ATIN, `**-***1234` for an EIN. */
export function maskTin(tinType: 'ein' | 'ssn' | 'itin', last4: string): string {
  const tail = last4.replace(/\D/g, '').slice(-4).padStart(4, '*');
  return tinType === 'ein' ? `**-***${tail}` : `***-**-${tail}`;
}

/** The full TIN with its usual dashes: `123-45-6789` or `12-3456789`. */
export function formatTin(tinType: 'ein' | 'ssn' | 'itin', tin: string): string {
  const digits = tin.replace(/\D/g, '');
  if (digits.length !== 9) return digits;
  return tinType === 'ein' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.round(value * 100) === 0) return '';
  return (Math.round(value * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function streetOf(address: Form1099PdfAddress): string[] {
  return [address.line1, address.line2 ?? ''].map((line) => (line ?? '').trim()).filter(Boolean);
}

function placeOf(address: Form1099PdfAddress): string {
  const place = [address.city, [address.state, address.zip].filter(Boolean).join(' ')].map((part) => part.trim()).filter(Boolean).join(', ');
  const country = address.country && address.country.toUpperCase() !== 'US' ? address.country.trim() : '';
  return [place, country].filter(Boolean).join(', ');
}

// Legends and instructions

const LEGEND_B =
  'This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.';

const COPY_INFO: Record<Form1099Copy, { label: string; legend: string }> = {
  B: { label: 'Copy B - For Recipient', legend: LEGEND_B },
  '1': { label: 'Copy 1 - For State Tax Department', legend: 'For State Tax Department.' },
  '2': { label: "Copy 2 - To be filed with recipient's state income tax return, when required", legend: "To be filed with recipient's state income tax return, when required." },
  C: {
    label: "Copy C - For Payer",
    legend: "For payer's records. For Privacy Act and Paperwork Reduction Act Notice, see the current General Instructions for Certain Information Returns.",
  },
};

const TIN_INSTRUCTION =
  "Recipient's taxpayer identification number (TIN). For your protection, this form may show only the last four digits of your TIN (SSN, ITIN, ATIN or EIN). The payer has reported your complete TIN to the IRS.";
const ACCOUNT_INSTRUCTION = 'Account number. May show an account or other unique number the payer assigned to distinguish your account.';
const CORRECTED_INSTRUCTION =
  'If this form is marked "CORRECTED", it replaces a form you received earlier. Use this one for your return.';
const STATE_INSTRUCTION = 'State information. Shows the state income and any state income tax withheld, reportable to your state tax department.';

const NEC_INSTRUCTIONS: string[] = [
  'Instructions for Recipient',
  TIN_INSTRUCTION,
  ACCOUNT_INSTRUCTION,
  'Box 1. Shows nonemployee compensation. If you are in the trade or business of catching fish, box 1 may show cash you received for the sale of fish. If the payments in box 1 are subject to self-employment tax, report them on Schedule C or Schedule F (Form 1040) and figure the tax on Schedule SE (Form 1040). You received this form instead of Form W-2 because the payer did not treat you as an employee and did not withhold income tax or social security and Medicare tax.',
  'Box 2. If checked, consumer products totaling $5,000 or more were sold to you for resale, on a buy-sell, deposit-commission or other basis. Any income from your sale of these products is reported on your return as business income.',
  'Box 3. Shows excess golden parachute payments subject to a 20% excise tax. Report the tax on Schedule 2 (Form 1040).',
  'Box 4. Shows backup withholding. A payer must withhold on certain payments if you did not give the payer your TIN. See Form W-9. Include this amount as tax withheld on your income tax return.',
  STATE_INSTRUCTION,
  CORRECTED_INSTRUCTION,
];

const MISC_INSTRUCTIONS: string[] = [
  'Instructions for Recipient',
  TIN_INSTRUCTION,
  ACCOUNT_INSTRUCTION,
  'Box 1. Shows rents from real estate or personal property. Report on Schedule E (Form 1040) if it is rental income, or on Schedule C or F if you are in that trade or business.',
  'Box 2. Shows royalties from oil, gas or mineral properties, copyrights and patents. Report on Schedule E (Form 1040), or on Schedule C if the royalties are from your trade or business.',
  'Box 3. Shows other income not reported elsewhere on the form. Report it on the appropriate line of your return.',
  'Box 4. Shows backup withholding or withholding on Indian gaming profits paid to tribal members. Include it as tax withheld on your return.',
  'Box 5. Shows your share of the proceeds from the sale of a catch or the fair market value of a distribution in kind from a fishing boat.',
  'Box 6. Shows payments to physicians or other suppliers of health and medical services. Report on Schedule C if it is your trade or business income.',
  'Box 7. If checked, consumer products totaling $5,000 or more were sold to you for resale. Report income from their sale on your return as business income.',
  'Box 8. Shows substitute payments in place of dividends or tax-exempt interest received by your broker on your behalf as a result of a loan of your securities.',
  'Box 9. Shows crop insurance proceeds. Report them on Schedule F (Form 1040) unless you elect to defer them to the following year.',
  'Box 10. Shows gross proceeds paid to an attorney in connection with legal services. The amount is not necessarily income to the attorney.',
  'Box 11. Shows cash paid for fish bought for resale from persons in the business of catching fish.',
  'Box 12. Shows deferrals under a nonqualified deferred compensation plan that are subject to section 409A.',
  'Box 13. If checked, you have a filing requirement under the Foreign Account Tax Compliance Act (FATCA).',
  'Box 14. Shows income under a nonqualified deferred compensation plan that does not meet the requirements of section 409A. This amount is also subject to an additional 20% tax and interest.',
  STATE_INSTRUCTION,
  CORRECTED_INSTRUCTION,
];

// Layout

const LABEL_SIZE = 6.5;
const VALUE_SIZE = 10;
const LEFT = 36;
const LEFT_WIDTH = 300;
const RIGHT = 336;
const RIGHT_WIDTH = 240;
const GRID_TOP = 90;
const ROW = 36;

function field(
  id: string,
  label: string,
  value: string,
  kind: PdfFieldKind,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<Form1099PdfField> = {},
): Form1099PdfField {
  return { id, label, value, kind, x, y, width, height, align: kind === 'amount' ? 'right' : 'left', ...extra };
}

function amountField(code: Form1099BoxCode, input: Form1099PdfInput, x: number, y: number, width: number, height = ROW): Form1099PdfField {
  const def = form1099Box(code)!;
  return field(
    `box_${code}`,
    `${def.number}  ${def.label}`,
    formatMoney(input.boxes[code]),
    'amount',
    x,
    y,
    width,
    height,
    { box: code },
  );
}

function checkboxField(code: Form1099BoxCode, checked: boolean | undefined, x: number, y: number, width: number): Form1099PdfField {
  const def = form1099Box(code)!;
  return field(`box_${code}`, `${def.number}  ${def.label}`, '', 'checkbox', x, y, width, ROW, { checked: Boolean(checked), box: code });
}

function stateFields(input: Form1099PdfInput, codes: [Form1099BoxCode, Form1099BoxCode, Form1099BoxCode], y: number, index: 0 | 1): Form1099PdfField[] {
  const state = input.states?.[index];
  const withheldDef = form1099Box(codes[0])!;
  const numberDef = form1099Box(codes[1])!;
  const incomeDef = form1099Box(codes[2])!;
  const suffix = `state${index + 1}`;
  return [
    field(`${suffix}_withheld`, `${withheldDef.number}  ${withheldDef.label}`, formatMoney(state?.withheld), 'amount', RIGHT, y, 80, ROW, { box: codes[0] }),
    field(
      `${suffix}_number`,
      `${numberDef.number}  ${numberDef.label}`,
      state ? [state.code.toUpperCase(), state.payerStateNumber ?? ''].filter(Boolean).join(' ') : '',
      'text',
      RIGHT + 80,
      y,
      80,
      ROW,
      { box: codes[1] },
    ),
    field(`${suffix}_income`, `${incomeDef.number}  ${incomeDef.label}`, formatMoney(state?.income), 'amount', RIGHT + 160, y, 80, ROW, { box: codes[2] }),
  ];
}

function leftColumn(input: Form1099PdfInput): Form1099PdfField[] {
  const { payer, recipient } = input;
  const payerLines = [payer.name, payer.nameLine2 ?? '', ...streetOf(payer.address), placeOf(payer.address), payer.phone ?? '']
    .map((line) => (line ?? '').trim())
    .filter(Boolean);
  const recipientName = [recipient.name, recipient.businessName ?? ''].map((line) => line.trim()).filter(Boolean).join('\n');
  const place = placeOf(recipient.address);
  const street = streetOf(recipient.address).join(', ');
  return [
    field(
      'payer',
      "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.",
      payerLines.join('\n'),
      'text',
      LEFT,
      GRID_TOP,
      LEFT_WIDTH,
      90,
      { multiline: true },
    ),
    field('payer_tin', "PAYER'S TIN", formatTin(payer.tinType, payer.tin), 'tin', LEFT, GRID_TOP + 90, 150, ROW),
    field('recipient_tin', "RECIPIENT'S TIN", maskTin(recipient.tinType, recipient.tinLast4), 'tin', LEFT + 150, GRID_TOP + 90, 150, ROW),
    field('recipient_name', "RECIPIENT'S name", recipientName, 'text', LEFT, GRID_TOP + 126, LEFT_WIDTH, ROW, { multiline: true }),
    field('recipient_street', 'Street address (including apt. no.)', street, 'text', LEFT, GRID_TOP + 162, LEFT_WIDTH, ROW),
    field('recipient_place', 'City or town, state or province, country, and ZIP or foreign postal code', place, 'text', LEFT, GRID_TOP + 198, LEFT_WIDTH, ROW),
    field('account_number', 'Account number (see instructions)', recipient.accountNumber ?? '', 'text', LEFT, GRID_TOP + 234, LEFT_WIDTH, ROW),
  ];
}

function header(input: Form1099PdfInput): Form1099PdfField[] {
  return [
    field('corrected', 'CORRECTED (if checked)', '', 'checkbox', RIGHT, GRID_TOP, 100, ROW, { checked: Boolean(input.corrected) }),
    field('tax_year', 'For calendar year', String(input.taxYear), 'text', RIGHT + 100, GRID_TOP, RIGHT_WIDTH - 100, ROW),
  ];
}

function necFields(input: Form1099PdfInput): { fields: Form1099PdfField[]; bottom: number } {
  const top = GRID_TOP + ROW;
  const fields = [
    ...header(input),
    amountField('nec_1', input, RIGHT, top, RIGHT_WIDTH, 54),
    checkboxField('nec_2', input.directSales, RIGHT, top + 54, RIGHT_WIDTH),
    amountField('nec_3', input, RIGHT, top + 90, RIGHT_WIDTH),
    amountField('nec_4', input, RIGHT, top + 126, RIGHT_WIDTH),
    ...stateFields(input, ['nec_5', 'nec_6', 'nec_7'], top + 162, 0),
    ...stateFields(input, ['nec_5', 'nec_6', 'nec_7'], top + 198, 1),
  ];
  return { fields, bottom: GRID_TOP + 270 };
}

const MISC_ROWS: Array<[Form1099BoxCode, Form1099BoxCode]> = [
  ['misc_1', 'misc_2'],
  ['misc_3', 'misc_4'],
  ['misc_5', 'misc_6'],
  ['misc_7', 'misc_8'],
  ['misc_9', 'misc_10'],
  ['misc_11', 'misc_12'],
  ['misc_13', 'misc_14'],
];

function miscFields(input: Form1099PdfInput): { fields: Form1099PdfField[]; bottom: number } {
  const half = RIGHT_WIDTH / 2;
  const fields: Form1099PdfField[] = [...header(input)];
  MISC_ROWS.forEach((row, index) => {
    const y = GRID_TOP + ROW + index * ROW;
    row.forEach((code, column) => {
      const x = RIGHT + column * half;
      if (code === 'misc_7') fields.push(checkboxField(code, input.directSales, x, y, half));
      else if (code === 'misc_13') fields.push(checkboxField(code, input.fatca, x, y, half));
      else fields.push(amountField(code, input, x, y, half));
    });
  });
  const stateTop = GRID_TOP + ROW + MISC_ROWS.length * ROW;
  fields.push(...stateFields(input, ['misc_15', 'misc_16', 'misc_17'], stateTop, 0));
  fields.push(...stateFields(input, ['misc_15', 'misc_16', 'misc_17'], stateTop + ROW, 1));
  return { fields, bottom: stateTop + 2 * ROW };
}

const FORM_TITLE: Record<Form1099Type, string> = {
  nec: 'Form 1099-NEC - Nonemployee Compensation',
  misc: 'Form 1099-MISC - Miscellaneous Information',
};

/** The layout of each requested copy of a form, ready to draw. */
export function form1099PdfCopies(input: Form1099PdfInput): Form1099PdfCopy[] {
  const copies = input.copies ?? [...FORM_1099_COPIES];
  const { fields: boxFields, bottom } = input.form === 'nec' ? necFields(input) : miscFields(input);
  const fields = [...leftColumn(input), ...boxFields];
  const formName = input.form === 'nec' ? '1099-NEC' : '1099-MISC';
  const instructions = input.form === 'nec' ? NEC_INSTRUCTIONS : MISC_INSTRUCTIONS;

  return copies.map((copy) => {
    const info = COPY_INFO[copy];
    const legendY = Math.max(bottom, GRID_TOP + 270) + 12;
    const blocks: Form1099PdfTextBlock[] = [
      { id: 'legend', x: LEFT, y: legendY, width: 540, fontSize: 8, lineHeight: 10, bold: true, paragraphs: [info.legend] },
    ];
    if (copy === 'B') {
      blocks.push({
        id: 'instructions',
        x: LEFT,
        y: legendY + 36,
        width: 540,
        fontSize: 7,
        lineHeight: 8.5,
        paragraphs: instructions,
        paragraphGap: 4,
      });
    }
    return {
      form: input.form,
      copy,
      taxYear: input.taxYear,
      page: LETTER_PAGE,
      title: `${FORM_TITLE[input.form]} (${input.taxYear})`,
      copyLabel: info.label,
      labelFontSize: LABEL_SIZE,
      valueFontSize: VALUE_SIZE,
      fields: fields.map((item) => ({ ...item })),
      blocks,
      footer: `Form ${formName} (${input.taxYear})  |  ${info.label}${copy === 'B' ? '  |  Keep for your records' : ''}`,
    };
  });
}
