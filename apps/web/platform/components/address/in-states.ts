/**
 * India's GST states and union territories with their GST state code (the
 * first two digits of a GSTIN). Names are proper nouns and are not translated.
 *
 * Mirrors `GST_SELECTABLE_STATES` in
 * `@weldsuite/books-domain/jurisdictions/in/states` (the platform doesn't import
 * the domain package); `in-states.test.ts` fails when the two drift apart.
 * An Indian address stores the state's name; the API reads the GST state code
 * from it (place of supply of an invoice).
 */
export interface InState {
  code: string;
  name: string;
  /** ISO 3166-2:IN suffix, e.g. MH. */
  abbr: string;
}

export const IN_STATES: ReadonlyArray<InState> = [
  { code: '01', name: 'Jammu and Kashmir', abbr: 'JK' },
  { code: '02', name: 'Himachal Pradesh', abbr: 'HP' },
  { code: '03', name: 'Punjab', abbr: 'PB' },
  { code: '04', name: 'Chandigarh', abbr: 'CH' },
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
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', abbr: 'DH' },
  { code: '27', name: 'Maharashtra', abbr: 'MH' },
  { code: '29', name: 'Karnataka', abbr: 'KA' },
  { code: '30', name: 'Goa', abbr: 'GA' },
  { code: '31', name: 'Lakshadweep', abbr: 'LD' },
  { code: '32', name: 'Kerala', abbr: 'KL' },
  { code: '33', name: 'Tamil Nadu', abbr: 'TN' },
  { code: '34', name: 'Puducherry', abbr: 'PY' },
  { code: '35', name: 'Andaman and Nicobar Islands', abbr: 'AN' },
  { code: '36', name: 'Telangana', abbr: 'TS' },
  { code: '37', name: 'Andhra Pradesh', abbr: 'AP' },
  { code: '38', name: 'Ladakh', abbr: 'LA' },
  { code: '97', name: 'Other Territory', abbr: 'OT' },
];

function fold(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The state for a name, GST code or ISO suffix ("Maharashtra", "27", "MH", "IN-MH"); undefined when nothing matches. */
export function findInState(value: string | null | undefined): InState | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const byCode = IN_STATES.find((s) => s.code === text);
  if (byCode) return byCode;
  const folded = fold(text);
  const byName = IN_STATES.find((s) => fold(s.name) === folded);
  if (byName) return byName;
  const abbr = text.toUpperCase().replace(/^IN[-\s]/, '');
  return IN_STATES.find((s) => s.abbr === abbr);
}

/** The name an address should store for what the user typed or an older record holds, else the value as it is. */
export function toInStateName(value: string | null | undefined): string {
  return findInState(value)?.name ?? value?.trim() ?? '';
}
