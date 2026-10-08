/**
 * Forms 1099-NEC and 1099-MISC: boxes, reporting thresholds per tax year, due
 * dates, e-file rules and the per-state direct-filing table.
 *
 * Sources: docs/plans/weldbooks-us-research/federal.md section 5 (Rev. Proc.
 * 2025-32 section 2.15, IR-2025-107, Pub 1099, Pub 1220 Rev. 5-2026, the
 * instructions for Forms 1099-MISC and 1099-NEC). Everything the research could
 * not confirm is marked `verified: false` or called out in a comment; check
 * those before relying on them for a filing season.
 */

import { addDays, formatIso, parseIso } from '../../us-compliance/dates';
import { rollToBusinessDay } from '../../us-compliance/federal-holidays';
import type { UsStateCode } from './states';

export type Form1099Type = 'nec' | 'misc';

export const FORM_1099_TYPES: readonly Form1099Type[] = ['nec', 'misc'];

export type Form1099BoxCode =
  | 'nec_1' | 'nec_2' | 'nec_3' | 'nec_4' | 'nec_5' | 'nec_6' | 'nec_7'
  | 'misc_1' | 'misc_2' | 'misc_3' | 'misc_4' | 'misc_5' | 'misc_6' | 'misc_7'
  | 'misc_8' | 'misc_9' | 'misc_10' | 'misc_11' | 'misc_12' | 'misc_13' | 'misc_14'
  | 'misc_15' | 'misc_16' | 'misc_17';

/** A box code stored on an account or bill line: a real box or `omit` (leave this out of 1099 reporting). */
export const FORM_1099_OMIT = 'omit';

export type Form1099BoxKind = 'amount' | 'checkbox' | 'state_amount' | 'state_text';

/** How a box is compared with the reporting threshold. */
export type Form1099ThresholdGroup =
  /** Section 6041(a): $600, $2,000 for payments made after 2025, indexed from 2027. */
  | 'general'
  /** Royalties and substitute payments: $10, not indexed. */
  | 'royalty'
  /** Attorney gross proceeds and fish purchases: $600, not indexed. */
  | 'fixed_600'
  /** Any positive amount (tax withheld, golden parachute). */
  | 'any_amount';

/** Who the box still gets reported for when the recipient is a corporation. */
export type CorporationRule = 'never' | 'attorney' | 'always';

export interface Form1099BoxDef {
  code: Form1099BoxCode;
  form: Form1099Type;
  /** Box number as printed on the form. */
  number: string;
  label: string;
  kind: Form1099BoxKind;
  /** Null for checkboxes and state fields, which are not compared with a threshold. */
  thresholdGroup: Form1099ThresholdGroup | null;
  /**
   * Corporations (including LLCs taxed as C or S corporations) are exempt
   * except for legal services (NEC 1, MISC 10), medical and health care
   * payments (MISC 6) and tax withheld (federal.md section 5). `attorney` =
   * reported only when the recipient is an attorney or law firm.
   */
  corporation: CorporationRule;
}

function box(
  code: Form1099BoxCode,
  form: Form1099Type,
  number: string,
  label: string,
  kind: Form1099BoxKind,
  thresholdGroup: Form1099ThresholdGroup | null,
  corporation: CorporationRule = 'never',
): Form1099BoxDef {
  return { code, form, number, label, kind, thresholdGroup, corporation };
}

export const FORM_1099_BOXES: readonly Form1099BoxDef[] = [
  box('nec_1', 'nec', '1', 'Nonemployee compensation', 'amount', 'general', 'attorney'),
  box('nec_2', 'nec', '2', 'Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', 'checkbox', null),
  box('nec_3', 'nec', '3', 'Excess golden parachute payments', 'amount', 'any_amount'),
  box('nec_4', 'nec', '4', 'Federal income tax withheld', 'amount', 'any_amount', 'always'),
  box('nec_5', 'nec', '5', 'State tax withheld', 'state_amount', null),
  box('nec_6', 'nec', '6', "State/Payer's state no.", 'state_text', null),
  box('nec_7', 'nec', '7', 'State income', 'state_amount', null),

  box('misc_1', 'misc', '1', 'Rents', 'amount', 'general'),
  box('misc_2', 'misc', '2', 'Royalties', 'amount', 'royalty'),
  box('misc_3', 'misc', '3', 'Other income', 'amount', 'general'),
  box('misc_4', 'misc', '4', 'Federal income tax withheld', 'amount', 'any_amount', 'always'),
  box('misc_5', 'misc', '5', 'Fishing boat proceeds', 'amount', 'general'),
  box('misc_6', 'misc', '6', 'Medical and health care payments', 'amount', 'general', 'always'),
  box('misc_7', 'misc', '7', 'Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', 'checkbox', null),
  box('misc_8', 'misc', '8', 'Substitute payments in lieu of dividends or interest', 'amount', 'royalty'),
  box('misc_9', 'misc', '9', 'Crop insurance proceeds', 'amount', 'general'),
  box('misc_10', 'misc', '10', 'Gross proceeds paid to an attorney', 'amount', 'fixed_600', 'always'),
  box('misc_11', 'misc', '11', 'Fish purchased for resale', 'amount', 'fixed_600'),
  box('misc_12', 'misc', '12', 'Section 409A deferrals', 'amount', 'general'),
  box('misc_13', 'misc', '13', 'FATCA filing requirement', 'checkbox', null),
  box('misc_14', 'misc', '14', 'Nonqualified deferred compensation', 'amount', 'general'),
  box('misc_15', 'misc', '15', 'State tax withheld', 'state_amount', null),
  box('misc_16', 'misc', '16', "State/Payer's state no.", 'state_text', null),
  box('misc_17', 'misc', '17', 'State income', 'state_amount', null),
];

const BOX_BY_CODE = new Map<string, Form1099BoxDef>(FORM_1099_BOXES.map((def) => [def.code, def]));

export function form1099Box(code: string): Form1099BoxDef | null {
  return BOX_BY_CODE.get(code) ?? null;
}

export function isForm1099BoxCode(code: string | null | undefined): code is Form1099BoxCode {
  return Boolean(code && BOX_BY_CODE.has(code));
}

export function form1099BoxesFor(form: Form1099Type): Form1099BoxDef[] {
  return FORM_1099_BOXES.filter((def) => def.form === form);
}

/** The federal income tax withheld box of a form (backup withholding goes here). */
export function withholdingBoxFor(form: Form1099Type): Form1099BoxCode {
  return form === 'nec' ? 'nec_4' : 'misc_4';
}

/** Boxes a payment can be allocated to: amount boxes other than tax withheld, which is computed from backup withholding. */
export function isAllocatableBox(code: string): boolean {
  const def = BOX_BY_CODE.get(code);
  return Boolean(def && def.kind === 'amount' && def.code !== 'nec_4' && def.code !== 'misc_4');
}

// Thresholds

export type Form1099ThresholdTable = Record<Form1099ThresholdGroup, number | null>;

interface ThresholdRule {
  /** First tax year (= year the payments were made) the amounts apply to. */
  fromYear: number;
  amounts: Form1099ThresholdTable;
}

/**
 * Amounts are compared with the payments made in the calendar year ("$600 or
 * more", so exactly the threshold is reported). The One Big Beautiful Bill Act
 * (section 70433) raised section 6041(a) to $2,000 for payments made after
 * 31 December 2025 and indexes it from 2027; Rev. Proc. 2025-32 section 2.15
 * lists which boxes follow it. Royalties, substitute payments, attorney gross
 * proceeds and fish purchases keep their own amounts.
 */
const THRESHOLD_RULES: readonly ThresholdRule[] = [
  { fromYear: 2020, amounts: { general: 600, royalty: 10, fixed_600: 600, any_amount: null } },
  { fromYear: 2026, amounts: { general: 2000, royalty: 10, fixed_600: 600, any_amount: null } },
];

/** The last tax year whose amounts are published; later years carry them forward until the IRS indexes. */
export const LAST_PUBLISHED_THRESHOLD_YEAR = 2026;

export interface Form1099ThresholdOverrides {
  /** Replaces the section 6041(a) amount, e.g. the inflation-indexed figure the IRS publishes for 2027. */
  general?: number;
  /** Replaces a single box's amount; `null` = report any positive amount. */
  boxes?: Partial<Record<Form1099BoxCode, number | null>>;
}

export interface Form1099ThresholdSet {
  taxYear: number;
  /**
   * False for a tax year after the last published one: the 2026 amounts are
   * carried forward because the IRS publishes the indexed amount later. Pass
   * the published figure as an override once it exists.
   */
  published: boolean;
  groups: Form1099ThresholdTable;
  /** The amount per box; null = any positive amount, absent = not compared. */
  boxes: Partial<Record<Form1099BoxCode, number | null>>;
}

/** Thresholds for payments made in `taxYear`. Tax years before 2020 predate the 1099-NEC and are not supported. */
export function form1099Thresholds(
  taxYear: number,
  overrides?: Form1099ThresholdOverrides,
): Form1099ThresholdSet {
  const first = THRESHOLD_RULES[0]!;
  if (!Number.isInteger(taxYear) || taxYear < first.fromYear) {
    throw new RangeError(`1099 thresholds start at tax year ${first.fromYear}; got ${taxYear}`);
  }
  let rule = first;
  for (const candidate of THRESHOLD_RULES) if (candidate.fromYear <= taxYear) rule = candidate;
  const groups: Form1099ThresholdTable = { ...rule.amounts };
  if (overrides?.general !== undefined) groups.general = overrides.general;

  const boxes: Partial<Record<Form1099BoxCode, number | null>> = {};
  for (const def of FORM_1099_BOXES) {
    if (def.thresholdGroup) boxes[def.code] = groups[def.thresholdGroup];
  }
  if (overrides?.boxes) {
    for (const [code, amount] of Object.entries(overrides.boxes)) {
      if (isForm1099BoxCode(code) && amount !== undefined) boxes[code] = amount;
    }
  }
  return { taxYear, published: taxYear <= LAST_PUBLISHED_THRESHOLD_YEAR, groups, boxes };
}

/** `amount` reaches the threshold; a null threshold means any positive amount. Compared in cents. */
export function meetsThreshold(amount: number, threshold: number | null | undefined): boolean {
  const cents = Math.round(amount * 100);
  if (threshold === null || threshold === undefined) return cents > 0;
  return cents >= Math.round(threshold * 100);
}

// Due dates

export interface Form1099Deadlines {
  taxYear: number;
  nec: {
    /** Recipient copy. No automatic extension. */
    recipient: string;
    /** IRS copy, paper or electronic. No automatic extension. */
    irs: string;
  };
  misc: {
    recipient: string;
    /** Recipient copy when box 8 or 10 is reported (15 February). */
    recipientBoxes8And10: string;
    irsPaper: string;
    irsElectronic: string;
  };
  /** Form 945 (backup withholding), due with the 1099s. */
  form945: string;
}

/**
 * Due dates for the forms of a tax year, each moved to the next business day
 * when it falls on a weekend or legal holiday (31 January 2027 is a Sunday, so
 * TY2026 recipient copies and 1099-NECs are due 1 February 2027). The 15
 * February date for MISC boxes 8 and 10 comes from the Pub 1099 table and was
 * flagged for a recheck in the research.
 */
export function form1099Deadlines(taxYear: number): Form1099Deadlines {
  const next = taxYear + 1;
  const jan31 = rollToBusinessDay(formatIso(next, 1, 31));
  return {
    taxYear,
    nec: { recipient: jan31, irs: jan31 },
    misc: {
      recipient: jan31,
      recipientBoxes8And10: rollToBusinessDay(formatIso(next, 2, 15)),
      irsPaper: rollToBusinessDay(formatIso(next, 2, 28)),
      irsElectronic: rollToBusinessDay(formatIso(next, 3, 31)),
    },
    form945: jan31,
  };
}

/** The filer has to e-file once the returns of all types together reach this number (T.D. 9972). */
export const FORM_1099_EFILE_THRESHOLD = 10;

/** Information returns of all kinds (1099, W-2, 1042-S, ...) are added together for the 10-return test. */
export function mustEFileInformationReturns(totalReturns: number): boolean {
  return totalReturns >= FORM_1099_EFILE_THRESHOLD;
}

/** Form 8508 (e-file waiver) has to reach the IRS at least this many days before the due date. */
export const FORM_8508_LEAD_DAYS = 45;

export function form8508Deadline(dueDate: string): string {
  return addDays(dueDate, -FORM_8508_LEAD_DAYS);
}

// Card and third-party payments

/**
 * Payment methods reported by the payment settlement entity on Form 1099-K,
 * so they are left out of 1099-NEC and 1099-MISC. The exclusion reads the
 * payment's method, never keywords in its reference.
 */
export const FORM_1099K_PAYMENT_METHODS: readonly string[] = ['credit_card', 'debit_card', 'third_party_network'];

/**
 * 1099-K reporting thresholds for a third-party settlement organization after
 * the One Big Beautiful Bill Act (section 70432) restored the old test: more
 * than $20,000 and more than 200 transactions. Payment-card acquirers have no
 * minimum. WeldBooks users receive the 1099-K; they do not file it.
 */
export const FORM_1099K_THRESHOLD = {
  grossPayments: 20_000,
  transactions: 200,
  comparison: 'more_than' as const,
};

// State filing

/**
 * When a state wants the 1099 filed with it directly even though the IRS
 * forwards the data under the Combined Federal/State Filing program:
 * `state_withholding` = only when state tax was withheld, `state_source` = the
 * recipient lives in the state or the work was done there, `unknown` = not
 * researched or sources disagree.
 */
export type StateDirectFiling = 'none' | 'state_withholding' | 'state_source' | 'unknown';

export interface Form1099StateRule {
  state: UsStateCode;
  /** Two-digit Combined Federal/State Filing code (Pub 1220 Rev. 5-2026); null = state does not participate. */
  cfsfCode: string | null;
  direct: StateDirectFiling;
  /** True only when the rule was confirmed against the state's own guidance. */
  verified: boolean;
  note?: string;
}

const CFSF_CODES: Partial<Record<UsStateCode, string>> = {
  AL: '01', AZ: '04', AR: '05', CA: '06', CO: '07', CT: '08', DE: '10', DC: '11',
  GA: '13', HI: '15', ID: '16', IN: '18', KS: '20', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MT: '30', NE: '31', NJ: '34', NM: '35',
  NC: '37', ND: '38', OH: '39', OK: '40', PA: '42', RI: '44', SC: '45', WI: '55',
};

const NO_INCOME_TAX: readonly UsStateCode[] = ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY'];

/**
 * Direct-filing triggers collected from vendor guides (Tax1099, BoomTax,
 * Sovos, TaxBandits), which disagree for several states; none of these were
 * confirmed with the states themselves, so every entry is `verified: false`.
 */
const DIRECT_FILING: Partial<Record<UsStateCode, { direct: StateDirectFiling; note: string }>> = {
  AL: { direct: 'state_withholding', note: 'Direct filing when Alabama tax was withheld.' },
  DE: { direct: 'state_source', note: 'Division of Revenue wants the 1099-NEC in addition to the IRS copy for residents and for work done in Delaware.' },
  GA: { direct: 'state_withholding', note: 'Direct filing when Georgia tax was withheld.' },
  HI: { direct: 'none', note: 'One guide says CF/SF satisfies Hawaii.' },
  KY: { direct: 'state_withholding', note: 'Not in CF/SF; direct filing only when Kentucky tax was withheld.' },
  MD: { direct: 'state_withholding', note: 'Direct filing when Maryland tax was withheld.' },
  MA: { direct: 'state_source', note: 'Department of Revenue wants direct filing despite CF/SF; one guide says NEC does not go through CF/SF.' },
  MI: { direct: 'state_source', note: 'Residents or Michigan withholding; the MISC rule is broader than the NEC one.' },
  MO: { direct: 'state_source', note: 'Removed from CF/SF; one guide says NEC is filed directly for Missouri-source payments of $1,200 or more.' },
  NY: { direct: 'unknown', note: 'Guides disagree on whether New York needs a separate filing.' },
  OR: { direct: 'state_source', note: 'One guide says all 1099s with Oregon withholding or an Oregon address go through iWire.' },
  PA: { direct: 'state_withholding', note: 'myPATH filing plus REV-1667 when Pennsylvania tax was withheld. CF/SF status of PA is disputed.' },
  WI: { direct: 'state_withholding', note: 'Separate file to the department of revenue when Wisconsin tax was withheld; some guides list broader triggers.' },
};

const VENDOR_FLAGGED: readonly UsStateCode[] = ['AZ', 'CT', 'IN', 'KS', 'LA', 'MN', 'MS', 'MT', 'NC', 'ND', 'OH', 'SC'];

const ALL_STATES: readonly UsStateCode[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

function buildStateRule(state: UsStateCode): Form1099StateRule {
  const cfsfCode = CFSF_CODES[state] ?? null;
  const known = DIRECT_FILING[state];
  if (known) return { state, cfsfCode, direct: known.direct, verified: false, note: known.note };
  if (NO_INCOME_TAX.includes(state)) {
    return { state, cfsfCode, direct: 'none', verified: false, note: 'No state income tax, so no state 1099 filing is expected.' };
  }
  if (VENDOR_FLAGGED.includes(state)) {
    return { state, cfsfCode, direct: 'unknown', verified: false, note: 'One vendor lists state-specific requirements that CF/SF does not satisfy; check the state.' };
  }
  return { state, cfsfCode, direct: 'unknown', verified: false, note: 'Not researched; check the state revenue department.' };
}

export const FORM_1099_STATE_RULES: readonly Form1099StateRule[] = ALL_STATES.map(buildStateRule);

const STATE_RULE_BY_CODE = new Map<string, Form1099StateRule>(FORM_1099_STATE_RULES.map((rule) => [rule.state, rule]));

export function form1099StateRule(state: string): Form1099StateRule | null {
  return STATE_RULE_BY_CODE.get(state.toUpperCase()) ?? null;
}

/**
 * Whether the filer has to do something beyond CF/SF for a recipient in
 * `state`, given the facts of the payment. `unknown` states return true when
 * there is any state connection, so the review screen asks the user to check.
 */
export function stateNeedsDirectFiling(
  state: string,
  facts: { stateWithheld?: boolean; stateSource?: boolean },
): boolean {
  const rule = form1099StateRule(state);
  if (!rule) return false;
  switch (rule.direct) {
    case 'none':
      return false;
    case 'state_withholding':
      return Boolean(facts.stateWithheld);
    case 'state_source':
    case 'unknown':
      return Boolean(facts.stateWithheld || facts.stateSource);
  }
}

/** The tax year a 1099 form covers for a payment date (cash basis: the year it was made). */
export function taxYearOfPayment(date: string): number {
  return parseIso(date).y;
}
