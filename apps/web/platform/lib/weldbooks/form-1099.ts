/**
 * The 1099 boxes an account can default to. Mirrors the amount boxes of
 * `FORM_1099_BOXES` in `@weldsuite/books-domain/jurisdictions/us/form-1099`
 * (the platform doesn't import the domain package). Federal tax withheld
 * (NEC 4, MISC 4) is left out: backup withholding computes it. Box names are
 * the IRS's and are not translated.
 */

export type Form1099Type = 'nec' | 'misc';

export interface Form1099Box {
  code: string;
  form: Form1099Type;
  /** Box number as printed on the form. */
  number: string;
  label: string;
}

/** Stored on an account to keep it out of 1099 reporting. */
export const FORM_1099_OMIT = 'omit';

export const FORM_1099_ACCOUNT_BOXES: readonly Form1099Box[] = [
  { code: 'nec_1', form: 'nec', number: '1', label: 'Nonemployee compensation' },
  { code: 'nec_3', form: 'nec', number: '3', label: 'Excess golden parachute payments' },
  { code: 'misc_1', form: 'misc', number: '1', label: 'Rents' },
  { code: 'misc_2', form: 'misc', number: '2', label: 'Royalties' },
  { code: 'misc_3', form: 'misc', number: '3', label: 'Other income' },
  { code: 'misc_5', form: 'misc', number: '5', label: 'Fishing boat proceeds' },
  { code: 'misc_6', form: 'misc', number: '6', label: 'Medical and health care payments' },
  { code: 'misc_8', form: 'misc', number: '8', label: 'Substitute payments in lieu of dividends or interest' },
  { code: 'misc_9', form: 'misc', number: '9', label: 'Crop insurance proceeds' },
  { code: 'misc_10', form: 'misc', number: '10', label: 'Gross proceeds paid to an attorney' },
  { code: 'misc_11', form: 'misc', number: '11', label: 'Fish purchased for resale' },
  { code: 'misc_12', form: 'misc', number: '12', label: 'Section 409A deferrals' },
  { code: 'misc_14', form: 'misc', number: '14', label: 'Nonqualified deferred compensation' },
];

/** Display name of a stored box code, e.g. `1099-NEC (1): Nonemployee compensation`; `1099-NEC (4)` for a box not listed. */
export function form1099BoxName(code: string): string {
  const box = FORM_1099_ACCOUNT_BOXES.find((b) => b.code === code);
  if (box) return `1099-${box.form.toUpperCase()} (${box.number}): ${box.label}`;
  const match = /^(nec|misc)_(\d+)$/.exec(code);
  return match ? `1099-${match[1].toUpperCase()} (${match[2]})` : code;
}

// ---------------------------------------------------------------------------
// Filing boxes (1099 Center): the amount boxes that appear on a filed form.
// ---------------------------------------------------------------------------

/** Federal income tax withheld: filled by backup withholding, never allocated from a bill. */
export const FORM_1099_WITHHOLDING_BOXES: Record<Form1099Type, string> = { nec: 'nec_4', misc: 'misc_4' };

const FORM_1099_WITHHOLDING: readonly Form1099Box[] = [
  { code: 'nec_4', form: 'nec', number: '4', label: 'Federal income tax withheld' },
  { code: 'misc_4', form: 'misc', number: '4', label: 'Federal income tax withheld' },
];

/** Every amount box of a form, in the order they print: the allocatable boxes plus the withholding box. */
export function form1099ReportBoxes(form: Form1099Type): Form1099Box[] {
  const all = [...FORM_1099_ACCOUNT_BOXES, ...FORM_1099_WITHHOLDING].filter((box) => box.form === form);
  return all.sort((a, b) => Number(a.number) - Number(b.number));
}

/** `1. Nonemployee compensation`: the box name without the form, for a table that already says which form. */
export function form1099BoxShortName(code: string): string {
  const box = [...FORM_1099_ACCOUNT_BOXES, ...FORM_1099_WITHHOLDING].find((b) => b.code === code);
  if (box) return `${box.number}. ${box.label}`;
  const match = /^(nec|misc)_(\d+)$/.exec(code);
  return match ? match[2] : code;
}

/** True for the federal income tax withheld box of either form. */
export function isForm1099WithholdingBox(code: string): boolean {
  return code === 'nec_4' || code === 'misc_4';
}

/** The form a box code belongs to, or null for a code that is not one. */
export function form1099OfBox(code: string): Form1099Type | null {
  if (code.startsWith('nec_')) return 'nec';
  if (code.startsWith('misc_')) return 'misc';
  return null;
}
