/**
 * Economic nexus rules per state, versioned by effective date.
 *
 * Seeded from docs/plans/weldbooks-us-research/sales-tax.md section 2.3
 * (Sales Tax Institute chart "as of 8/1/2026", updated for the Illinois,
 * Kentucky and Utah changes in section 2.2). Every number below is a row of
 * that table. Where the research could not settle a cell it is listed in
 * `unverified` so the UI can say "check with the state" instead of guessing;
 * see section 12 of the research (marketplace inclusion, collection start).
 *
 * Thresholds, windows and bases change by law. Add a new version (never edit
 * an old one) when a state changes its rule, so a measurement for an earlier
 * period still uses the rule of that time. Review every December.
 */

import type { UsStateCode } from './states';

/** A state or Puerto Rico (a separate jurisdiction in the sales tax engine). */
export type NexusJurisdictionCode = UsStateCode | 'PR';

/** How the transaction count combines with the sales threshold: no count test, either one, or both. */
export type NexusTransactionTest = 'none' | 'or' | 'and';

/** Which sales count: all sales into the state, retail sales (no resale), or taxable sales only. */
export type NexusBase = 'gross' | 'retail' | 'taxable';

export type NexusWindow =
  /** Exceeded in the previous calendar year or in the current one so far. */
  | 'previous_or_current_calendar_year'
  /** Exceeded in the previous calendar year; the current year only warns. */
  | 'previous_calendar_year'
  /** The 12 months ending today (or, when `testedQuarterly`, ending the last completed calendar quarter). */
  | 'rolling_12_months'
  /** The last four completed quarters (calendar quarters, or NY sales tax quarters via `quarterFirstMonth`). */
  | 'rolling_four_quarters'
  /** Connecticut: the 12 months ending 30 September. */
  | 'ct_october_september';

/** When collecting must start once the threshold is crossed. */
export type CollectionStartRule =
  /** From the first sale after the one that crossed it. */
  | { kind: 'next_transaction' }
  | { kind: 'first_day_of_next_month' }
  | { kind: 'days_after'; days: number };

export type NexusUnverified =
  | 'marketplace'
  | 'collection_start'
  | 'window'
  | 'base'
  | 'effective_date'
  | 'transaction_test';

export interface NexusRule {
  stateCode: NexusJurisdictionCode;
  /** First day this version applies. */
  effectiveFrom: string;
  /** False for states with no sales tax to collect (DE, MT, NH, OR): nothing to monitor. */
  hasSalesTax: boolean;
  /** Dollar threshold; null when the state has no sales tax. */
  salesThreshold: number | null;
  /** Transaction-count threshold; null when there is no count test. */
  transactionThreshold: number | null;
  test: NexusTransactionTest;
  /** `gte`: reaching the threshold counts. `gt`: it has to be exceeded (Mississippi, New York). */
  comparison: 'gte' | 'gt';
  base: NexusBase;
  window: NexusWindow;
  /** `rolling_four_quarters`: first month of a quarter (1 = calendar quarters, 3 = New York sales tax quarters). */
  quarterFirstMonth?: number;
  /** `rolling_12_months`: the state tests at the end of each calendar quarter, not continuously. */
  testedQuarterly?: boolean;
  /** Sales through a marketplace facilitator count toward the seller's own threshold. */
  marketplaceSalesCount: boolean;
  collectionStart: CollectionStartRule;
  /** Cells the research could not settle. */
  unverified: readonly NexusUnverified[];
  sourceUrl: string;
  notes?: string;
}

/** Date of the research this table was seeded from. */
export const NEXUS_THRESHOLDS_REVIEWED_ON = '2026-10-08';

const STI = 'https://www.salestaxinstitute.com/resources/economic-nexus-state-guide';
const WAYFAIR_DECISION = '2018-06-21';
const NEXT_TRANSACTION: CollectionStartRule = { kind: 'next_transaction' };

interface Spec {
  base: NexusBase;
  /** Marketplace facilitated sales count toward the threshold. */
  mkt: boolean;
  sales?: number;
  test?: 'or' | 'and';
  tx?: number;
  gt?: boolean;
  window?: NexusWindow;
  quarterFirstMonth?: number;
  quarterly?: boolean;
  start?: CollectionStartRule;
  unverified?: NexusUnverified[];
  url?: string;
  notes?: string;
}

/**
 * Collection start is not in the research (section 12, item 6), so every rule
 * defaults to the conservative "next transaction" and says so.
 */
function v(stateCode: NexusJurisdictionCode, effectiveFrom: string, spec: Spec): NexusRule {
  const test = spec.test ?? 'none';
  const rule: NexusRule = {
    stateCode,
    effectiveFrom,
    hasSalesTax: true,
    salesThreshold: spec.sales ?? 100_000,
    transactionThreshold: test === 'none' ? null : (spec.tx ?? 200),
    test,
    comparison: spec.gt ? 'gt' : 'gte',
    base: spec.base,
    window: spec.window ?? 'previous_or_current_calendar_year',
    marketplaceSalesCount: spec.mkt,
    collectionStart: spec.start ?? NEXT_TRANSACTION,
    unverified: ['collection_start', ...(spec.unverified ?? [])],
    sourceUrl: spec.url ?? STI,
  };
  if (spec.quarterFirstMonth !== undefined) rule.quarterFirstMonth = spec.quarterFirstMonth;
  if (spec.quarterly) rule.testedQuarterly = true;
  if (spec.notes) rule.notes = spec.notes;
  return rule;
}

function noSalesTax(stateCode: NexusJurisdictionCode, notes: string): NexusRule {
  return {
    stateCode,
    effectiveFrom: WAYFAIR_DECISION,
    hasSalesTax: false,
    salesThreshold: null,
    transactionThreshold: null,
    test: 'none',
    comparison: 'gte',
    base: 'gross',
    window: 'previous_or_current_calendar_year',
    marketplaceSalesCount: false,
    collectionStart: NEXT_TRANSACTION,
    unverified: [],
    sourceUrl: 'https://taxfoundation.org/data/all/state/2026-sales-tax-rates-midyear/',
    notes,
  };
}

const PRE_REMOVAL = 'The 200-transaction test applied until it was removed (see the next version).';

const ILLINOIS_URL = 'https://tax.illinois.gov/research/publications/bulletins/fy-2026-12.html';
const KENTUCKY_URL =
  'https://www.avalara.com/blog/en/north-america/2026/04/kentucky-removes-transaction-threshold-taxes-data-brokering-services.html';
const AVALARA_REMOVALS_URL =
  'https://www.avalara.com/blog/en/north-america/2025/06/states-eliminating-economic-nexus-transaction-thresholds.html';

/**
 * Every version of every state's rule, grouped by state and in date order.
 * Order the states alphabetically by code; versions of one state ascending.
 */
export const NEXUS_RULES: readonly NexusRule[] = [
  v('AL', '2018-10-01', {
    sales: 250_000, base: 'retail', window: 'previous_calendar_year', mkt: false,
    notes: 'Remote sellers may opt into the Simplified Sellers Use Tax flat 8% program.',
  }),
  v('AK', WAYFAIR_DECISION, {
    test: 'or', base: 'gross', mkt: true, unverified: ['effective_date'],
    url: 'https://www.avalara.com/blog/en/north-america/2024/11/alaska-removes-economic-nexus-transaction-threshold.html',
    notes: `Alaska Remote Seller Sales Tax Commission member municipalities only (local tax). Start date of the rule is not in the research. ${PRE_REMOVAL}`,
  }),
  v('AK', '2025-01-01', {
    base: 'gross', mkt: true,
    url: 'https://www.avalara.com/blog/en/north-america/2024/11/alaska-removes-economic-nexus-transaction-threshold.html',
    notes: 'Transaction test removed on 1 January 2025. Local tax only, per adopting municipality.',
  }),
  v('AZ', '2019-10-01', { sales: 200_000, base: 'gross', mkt: false, unverified: ['marketplace'], notes: 'Stepped down: $200,000 (2019), $150,000 (2020), $100,000 (2021 onwards).' }),
  v('AZ', '2020-01-01', { sales: 150_000, base: 'gross', mkt: false, unverified: ['marketplace'] }),
  v('AZ', '2021-01-01', { base: 'gross', mkt: false, unverified: ['marketplace'] }),
  v('AR', '2019-07-01', { test: 'or', base: 'taxable', mkt: false }),
  v('CA', '2019-04-01', { sales: 500_000, base: 'gross', mkt: true, notes: 'Gross sales of tangible personal property delivered into California.' }),
  v('CO', '2018-12-01', { base: 'retail', mkt: false, notes: 'Enforced from 1 June 2019. The 200-transaction test was removed in 2019.' }),
  v('CT', '2019-07-01', {
    test: 'and', base: 'retail', mkt: true, window: 'ct_october_september',
    notes: 'Both tests must be met in the 12 months ending 30 September. Rule started 1 December 2018; $100,000 applies since 1 July 2019.',
  }),
  v('DC', '2019-01-01', { test: 'or', base: 'retail', mkt: true }),
  v('FL', '2021-07-01', { base: 'taxable', window: 'previous_calendar_year', mkt: false, notes: 'Taxable remote sales.' }),
  v('GA', '2020-01-01', { test: 'or', base: 'retail', mkt: false, notes: 'Rule started 1 January 2019; $100,000 applies since 1 January 2020.' }),
  v('HI', '2018-07-01', { test: 'or', base: 'gross', mkt: true, notes: 'General excise tax, a tax on the seller.' }),
  v('ID', '2019-06-01', { base: 'gross', mkt: true }),
  v('IL', '2018-10-01', {
    test: 'or', base: 'retail', window: 'rolling_12_months', quarterly: true, mkt: false, url: ILLINOIS_URL,
    notes: `Gross receipts (retail) of the preceding 12 months, reviewed quarterly. ${PRE_REMOVAL}`,
  }),
  v('IL', '2026-01-01', {
    base: 'retail', window: 'rolling_12_months', quarterly: true, mkt: false, url: ILLINOIS_URL,
    notes: 'Transaction test removed on 1 January 2026 (P.A. 104-0006). Destination sales with insufficient location data are taxed at 15%.',
  }),
  v('IN', '2018-10-01', { test: 'or', base: 'gross', mkt: false, url: AVALARA_REMOVALS_URL, notes: PRE_REMOVAL }),
  v('IN', '2024-01-01', { base: 'gross', mkt: false, url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 1 January 2024.' }),
  v('IA', '2019-01-01', { base: 'gross', mkt: true, notes: 'The 200-transaction test was removed in 2019.' }),
  v('KS', '2021-07-01', { base: 'gross', mkt: true }),
  v('KY', '2018-10-01', { test: 'or', base: 'gross', mkt: true, url: KENTUCKY_URL, notes: PRE_REMOVAL }),
  v('KY', '2026-08-01', { base: 'gross', mkt: true, url: KENTUCKY_URL, notes: 'Transaction test removed on 1 August 2026 (HB 757).' }),
  v('LA', '2020-07-01', { test: 'or', base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: `Remote sellers can file with the Louisiana Sales and Use Tax Commission for Remote Sellers. ${PRE_REMOVAL}` }),
  v('LA', '2023-08-01', { base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 1 August 2023.' }),
  v('ME', '2018-07-01', { test: 'or', base: 'gross', mkt: false, url: AVALARA_REMOVALS_URL, notes: PRE_REMOVAL }),
  v('ME', '2022-01-01', { base: 'gross', mkt: false, url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 1 January 2022.' }),
  v('MD', '2018-10-01', { test: 'or', base: 'gross', mkt: true }),
  v('MA', '2019-10-01', { base: 'gross', mkt: false, unverified: ['marketplace'], notes: 'Marketplace sales are excluded when the facilitator collects. Replaced the $500,000 and 100-transaction rule of October 2017.' }),
  v('MI', '2018-10-01', { test: 'or', base: 'gross', window: 'previous_calendar_year', mkt: true }),
  v('MN', '2018-10-01', {
    test: 'or', base: 'retail', window: 'rolling_12_months', quarterly: true, mkt: true,
    notes: 'The 12 months ending the last day of the most recent completed quarter; the transaction test counts retail sales.',
  }),
  v('MS', '2018-09-01', { sales: 250_000, gt: true, base: 'gross', window: 'rolling_12_months', mkt: false, notes: 'More than $250,000 in the prior 12 months.' }),
  v('MO', '2023-01-01', { base: 'taxable', window: 'rolling_12_months', quarterly: true, mkt: true, notes: 'The previous 12 months, tested quarterly. Last state to adopt economic nexus.' }),
  v('NE', '2019-01-01', { test: 'or', base: 'retail', mkt: true, notes: 'Table lists 1 January / 1 April 2019; the earlier date is used.', unverified: ['effective_date'] }),
  v('NV', '2018-11-01', { test: 'or', base: 'retail', mkt: true }),
  v('NJ', '2018-11-01', {
    test: 'or', base: 'gross', mkt: true, url: 'https://legiscan.com/NJ/research/S711/2026',
    notes: 'Bill S711 to remove the transaction test is pending (not enacted as of the research). Add a new version when it is.',
  }),
  v('NM', '2019-07-01', { base: 'taxable', window: 'previous_calendar_year', mkt: false, notes: 'Taxable gross receipts.' }),
  v('NY', '2019-06-24', {
    sales: 500_000, test: 'and', tx: 100, gt: true, base: 'gross', window: 'rolling_four_quarters', quarterFirstMonth: 3, mkt: true,
    unverified: ['window'],
    notes: 'More than $500,000 and more than 100 sales in the immediately preceding four sales tax quarters (Mar-May, Jun-Aug, Sep-Nov, Dec-Feb; the quarter months are not spelled out in the research).',
  }),
  v('NC', '2018-11-01', { test: 'or', base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: PRE_REMOVAL }),
  v('NC', '2024-07-01', { base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 1 July 2024.' }),
  v('NC', '2026-07-01', {
    base: 'gross', mkt: true, start: { kind: 'days_after', days: 60 },
    notes: 'The Sales Tax Institute reports that collection starts 60 days after crossing since July 2026; not confirmed with the department of revenue.',
  }),
  v('ND', '2018-10-01', { base: 'taxable', mkt: false, notes: 'The 200-transaction test was removed for periods after 2018.' }),
  v('OH', '2019-08-01', { test: 'or', base: 'retail', mkt: true, notes: 'Replaced the $500,000 rule of January 2018.' }),
  v('OK', '2019-11-01', { base: 'taxable', mkt: false }),
  v('PA', '2019-07-01', { base: 'gross', window: 'rolling_12_months', mkt: true, notes: 'Gross sales through all channels.' }),
  v('RI', '2019-07-01', { test: 'or', base: 'gross', window: 'previous_calendar_year', mkt: true }),
  v('SC', '2018-11-01', { base: 'gross', mkt: true }),
  v('SD', '2018-11-01', { test: 'or', base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: PRE_REMOVAL }),
  v('SD', '2023-07-01', { base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 1 July 2023.' }),
  v('TN', '2020-10-01', { base: 'retail', window: 'rolling_12_months', mkt: false, notes: 'Rule started 1 October 2019; $100,000 applies since 1 October 2020.' }),
  v('TX', '2019-10-01', { sales: 500_000, base: 'gross', window: 'rolling_12_months', mkt: true, notes: 'Gross revenue of the preceding 12 calendar months.' }),
  v('UT', '2019-01-01', { test: 'or', base: 'gross', mkt: false, unverified: ['marketplace'], notes: PRE_REMOVAL }),
  v('UT', '2025-07-01', { base: 'gross', mkt: false, unverified: ['marketplace'], notes: 'Transaction test removed on 1 July 2025.' }),
  v('VT', '2018-07-01', { test: 'or', base: 'gross', window: 'rolling_four_quarters', quarterFirstMonth: 1, mkt: true, notes: 'The prior four calendar quarters.' }),
  v('VA', '2019-07-01', { test: 'or', base: 'retail', mkt: false }),
  v('WA', '2018-10-01', { base: 'gross', mkt: true, notes: 'Gross income as defined for the business and occupation tax. The 200-transaction test was removed in 2019.' }),
  v('WV', '2019-01-01', { test: 'or', base: 'gross', mkt: true }),
  v('WI', '2018-10-01', { test: 'or', base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: PRE_REMOVAL }),
  v('WI', '2021-02-20', { base: 'gross', mkt: true, url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 20 February 2021.' }),
  v('WY', '2019-02-01', { test: 'or', base: 'gross', mkt: false, unverified: ['marketplace'], url: AVALARA_REMOVALS_URL, notes: PRE_REMOVAL }),
  v('WY', '2024-07-01', { base: 'gross', mkt: false, unverified: ['marketplace'], url: AVALARA_REMOVALS_URL, notes: 'Transaction test removed on 1 July 2024.' }),
  v('PR', '2021-01-01', {
    test: 'or', base: 'gross', mkt: false, unverified: ['window'],
    notes: 'Puerto Rico is its own sales tax jurisdiction (IVU). The research lists the seller\'s fiscal year as the window; calendar years are used until the seller\'s year is known.',
  }),
  noSalesTax('DE', 'No sales tax. The seller pays a gross receipts tax that is not collected from customers.'),
  noSalesTax('MT', 'No general sales tax (resort-area and lodging taxes exist).'),
  noSalesTax('NH', 'No general sales tax; a meals and rooms tax applies to prepared meals, rentals and lodging.'),
  noSalesTax('OR', 'No sales tax. The Corporate Activity Tax is a gross receipts tax on the seller.'),
];

const BY_STATE = new Map<NexusJurisdictionCode, NexusRule[]>();
for (const rule of NEXUS_RULES) {
  const list = BY_STATE.get(rule.stateCode) ?? [];
  list.push(rule);
  BY_STATE.set(rule.stateCode, list);
}
for (const list of BY_STATE.values()) list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

/** Every jurisdiction with a rule, including the four states with no sales tax. */
export function nexusJurisdictionCodes(): NexusJurisdictionCode[] {
  return [...BY_STATE.keys()].sort();
}

/** Jurisdictions a seller can have to collect sales tax in. */
export function nexusMonitoredCodes(): NexusJurisdictionCode[] {
  return nexusJurisdictionCodes().filter((code) => BY_STATE.get(code)?.some((rule) => rule.hasSalesTax));
}

/** All versions of a state's rule, oldest first. */
export function getNexusRuleHistory(stateCode: string): readonly NexusRule[] {
  return BY_STATE.get(stateCode.trim().toUpperCase() as NexusJurisdictionCode) ?? [];
}

/** The rule in force on a date (`YYYY-MM-DD`); undefined before the state's first rule or for an unknown code. */
export function getNexusRule(stateCode: string, asOf: string): NexusRule | undefined {
  const history = getNexusRuleHistory(stateCode);
  let current: NexusRule | undefined;
  for (const rule of history) {
    if (rule.effectiveFrom <= asOf) current = rule;
  }
  return current;
}
