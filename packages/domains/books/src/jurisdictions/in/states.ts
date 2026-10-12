/**
 * India's GST state and union territory codes (the first two digits of a
 * GSTIN, and the "place of supply" code on a tax invoice).
 *
 * Codes 25 and 28 are retired (Daman and Diu merged into 26, the old Andhra
 * Pradesh became 37) but were issued, so existing GSTINs may still carry them.
 */

export interface GstState {
  code: string;
  name: string;
  /** ISO 3166-2:IN suffix (MH for IN-MH), also what people type. */
  abbr: string;
  /** Union territory without a legislature: intra-UT supplies carry UTGST instead of SGST. */
  utgst?: boolean;
  /** No longer issued; kept so older GSTINs still validate. */
  retired?: boolean;
}

export const GST_STATES: readonly GstState[] = [
  { code: '01', name: 'Jammu and Kashmir', abbr: 'JK' },
  { code: '02', name: 'Himachal Pradesh', abbr: 'HP' },
  { code: '03', name: 'Punjab', abbr: 'PB' },
  { code: '04', name: 'Chandigarh', abbr: 'CH', utgst: true },
  { code: '05', name: 'Uttarakhand', abbr: 'UK' },
  { code: '06', name: 'Haryana', abbr: 'HR' },
  { code: '07', name: 'Delhi', abbr: 'DL' },
  { code: '08', name: 'Rajasthan', abbr: 'RJ' },
  { code: '09', name: 'Uttar Pradesh', abbr: 'UP' },
  { code: '10', name: 'Bihar', abbr: 'BR' },
  { code: '11', name: 'Sikkim', abbr: 'SK' },
  { code: '12', name: 'Arunachal Pradesh', abbr: 'AR' },
  { code: '13', name: 'Nagaland', abbr: 'NL' },
  { code: '14', name: 'Manipur', abbr: 'MN' },
  { code: '15', name: 'Mizoram', abbr: 'MZ' },
  { code: '16', name: 'Tripura', abbr: 'TR' },
  { code: '17', name: 'Meghalaya', abbr: 'ML' },
  { code: '18', name: 'Assam', abbr: 'AS' },
  { code: '19', name: 'West Bengal', abbr: 'WB' },
  { code: '20', name: 'Jharkhand', abbr: 'JH' },
  { code: '21', name: 'Odisha', abbr: 'OD' },
  { code: '22', name: 'Chhattisgarh', abbr: 'CG' },
  { code: '23', name: 'Madhya Pradesh', abbr: 'MP' },
  { code: '24', name: 'Gujarat', abbr: 'GJ' },
  { code: '25', name: 'Daman and Diu', abbr: 'DD', utgst: true, retired: true },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', abbr: 'DH', utgst: true },
  { code: '27', name: 'Maharashtra', abbr: 'MH' },
  { code: '28', name: 'Andhra Pradesh (before division)', abbr: 'AP', retired: true },
  { code: '29', name: 'Karnataka', abbr: 'KA' },
  { code: '30', name: 'Goa', abbr: 'GA' },
  { code: '31', name: 'Lakshadweep', abbr: 'LD', utgst: true },
  { code: '32', name: 'Kerala', abbr: 'KL' },
  { code: '33', name: 'Tamil Nadu', abbr: 'TN' },
  { code: '34', name: 'Puducherry', abbr: 'PY' },
  { code: '35', name: 'Andaman and Nicobar Islands', abbr: 'AN', utgst: true },
  { code: '36', name: 'Telangana', abbr: 'TS' },
  { code: '37', name: 'Andhra Pradesh', abbr: 'AP' },
  { code: '38', name: 'Ladakh', abbr: 'LA', utgst: true },
  { code: '97', name: 'Other Territory', abbr: 'OT', utgst: true },
];

/** Place-of-supply code for a supply outside India (e-invoice convention). Not a valid GSTIN prefix. */
export const GST_FOREIGN_COUNTRY_CODE = '96';

const BY_CODE = new Map(GST_STATES.map((s) => [s.code, s]));

/** The states a user can pick for a new address (retired codes left out). */
export const GST_SELECTABLE_STATES: readonly GstState[] = GST_STATES.filter((s) => !s.retired);

/** True for the 01-38 and 97 codes a GSTIN may start with (00, 99 and the rest are rejected). */
export function isValidGstStateCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && BY_CODE.has(code);
}

export function gstStateName(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  if (code === GST_FOREIGN_COUNTRY_CODE) return 'Foreign Country';
  return BY_CODE.get(code)?.name;
}

/** Whether intra-state supplies in this state/UT carry UTGST rather than SGST. */
export function usesUtgst(code: string | null | undefined): boolean {
  return Boolean(code && BY_CODE.get(code)?.utgst);
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const NAME_ALIASES: Record<string, string> = {
  orissa: '21',
  pondicherry: '34',
  'nct of delhi': '07',
  'new delhi': '07',
  'jammu kashmir': '01',
  'dadra and nagar haveli': '26',
  'daman and diu': '26',
  'daman diu': '26',
  'andaman nicobar islands': '35',
  'andaman and nicobar': '35',
  uttaranchal: '05',
  bangalore: '29',
  bengaluru: '29',
};

const NAME_INDEX = new Map<string, string>();
for (const s of GST_STATES) {
  if (s.retired && s.code === '28') continue;
  NAME_INDEX.set(fold(s.name), s.code);
}
for (const [alias, code] of Object.entries(NAME_ALIASES)) NAME_INDEX.set(alias, code);

/**
 * GST state code for what an address holds in its state field: a two-digit
 * code, a state name ("Maharashtra"), the ISO suffix ("MH" or "IN-MH").
 * Undefined when nothing matches; never guesses.
 */
export function gstStateCodeFromText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d{2}$/.test(trimmed)) return isValidGstStateCode(trimmed) ? trimmed : undefined;
  const byName = NAME_INDEX.get(fold(trimmed));
  if (byName) return byName;
  const abbr = trimmed.toUpperCase().replace(/^IN[-\s]/, '');
  if (/^[A-Z]{2}$/.test(abbr)) {
    const hit = GST_STATES.find((s) => s.abbr === abbr && !s.retired);
    if (hit) return hit.code;
  }
  // "27 - Maharashtra" / "27-MH"
  const leading = /^(\d{2})\b/.exec(trimmed);
  if (leading && isValidGstStateCode(leading[1])) return leading[1];
  return undefined;
}
