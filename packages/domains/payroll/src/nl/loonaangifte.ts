/**
 * The Dutch payroll tax return (aangifte loonheffingen) for one employer and
 * one monthly period, as the Belastingdienst's XML message, plus the payment
 * reference (betalingskenmerk), the due date and a printable summary.
 *
 * Specifications (ODB release Loonheffingen Aangifte 2026v09,
 * https://odb.belastingdienst.nl/wp-content/uploads/2026/01/LH2026v09.zip):
 * - [GS] Gegevensspecificatie aangifte loonheffingen 2026, versie 3.0 (1 januari 2026):
 *   meaning, conditions and code tables of every rubriek.
 * - [XSD] Loonaangifte2026v2.0.xsd: element names, order and formats
 *   (namespace http://xml.belastingdienst.nl/schemas/Loonaangifte/2026/01, version="2.0").
 * - [BS] Berichtspecificatie aangifte loonheffingen 2026 v2.0: encoding (UTF-8 or
 *   ISO 8859-1), character set, date formats (EEJJ-MM-DD, EEJJ-MM-DDTHH:MM:SS).
 * - [BK] Specificatie Betalingskenmerk v1.0 (Servicedocumenten): the 16-digit
 *   payment reference derived from the loonheffingennummer, year and period.
 * - [TV] TijdvakCodesAangifteBetaalDatums 2026/2027: filing and payment deadlines.
 * - 2027 (LH2027v1.5, XSD Loonaangifte2027v2.0): namespace …/Loonaangifte/2027/01;
 *   new optional collective element EhFossAutos (eindheffing fossil company cars)
 *   after EhOvsFrfWrkkstrg; IndAvrLkvOudrWn removed from Inkomstenperiode. This
 *   builder never writes either element, so the same structure serves both years.
 *
 * Corrections of earlier periods of the same year travel with the current
 * return as TijdvakCorrectie groups (GS §2.4.1): each has the corrected
 * period's full collective part and the employee data, and the current
 * return carries per corrected period the `SaldoCorrectiesVoorgaandTijdvak`
 * (new TotTeBet minus the TotTeBet last reported for that period in a return
 * of an earlier period, GS §2.3.2/§2.4.1/§4.2) and `TotGen` = TotTeBet + saldi.
 * Corrections of an earlier year are a separate message under that year's
 * specification (GS §2.4.3) and are not built here.
 */

import type { GeneratedFile, PayrollDocument } from '../documents';
import { fromCents } from '../money';
import type { NlFilingData, PayrollIssue } from '../types';
import { nlAowDate } from './calculate';
import { brpNationalityCode } from './nationality';
import { nlRulesForYear } from './rules';
import { el, serialize, type XmlNode } from './xml';

export interface NlEmployeeIdentity {
  /** BSN; null only for an anonymous employee. */
  bsn: string | null;
  /** `J.M.` */
  initials: string;
  surnamePrefix: string | null;
  surname: string;
  dateOfBirth: string | null;
  /** ISO 3166-1 alpha-2 (or a 4-digit BRP nationality code). */
  nationality: string | null;
  /** 1 male, 2 female, 0 unknown. Null = not recorded (code 9). */
  gender: 0 | 1 | 2 | null;
  /** Home address: required for every employee except an anonymous one (GS condition 0050.1). */
  address?: {
    street?: string | null;
    houseNumber?: string | null;
    houseNumberAddition?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
  personnelNumber?: string | null;
}

/** One income relationship in the return, with its figures for the period. */
export interface LoonaangifteIkv {
  identity: NlEmployeeIdentity;
  incomeRelationshipNumber: number;
  employmentStart: string;
  employmentEnd: string | null;
  /** The period's payslips summed (`sumNlFilingData`). */
  filing: NlFilingData;
  /**
   * Additive: Code reden einde arbeidsverhouding (GS 5.1, e.g. `30` end of a fixed-term
   * contract, `20` resignation). Required when the employment ended; `99` when omitted (warning).
   */
  endReasonCode?: string | null;
  /** Additive: cao code (GS 5.5 Code cao); 9999 "geen reguliere cao van toepassing" when omitted. */
  caoCode?: number | null;
  /**
   * Additive: the income-relationship number for a transitievergoeding paid in
   * this period. That payment is loon uit vroegere dienstbetrekking (green
   * table) and goes in its own income relationship with inkomenscode 62 (GS
   * begrippenlijst "Samenloop of wijziging van loonbelastingtabelkleur").
   */
  transitionPaymentIncomeRelationshipNumber?: number | null;
}

export interface LoonaangifteInput {
  employer: {
    loonheffingennummer: string;
    name: string;
    contactName: string | null;
    contactPhone: string | null;
    /** Additive: sectorcode from the Belastingdienst's decision (GS 5.7 Sector). */
    sectorCode?: number | null;
  };
  /** Additive `relationNumber`: the software developer's ODB relatienummer `SWOxxxxx` (GS 3.1 RelNr). */
  software: { name: string; version: string; relationNumber?: string | null };
  taxYear: number;
  period: { start: string; end: string };
  ikvs: LoonaangifteIkv[];
  /**
   * Earlier periods of the same year that changed since they were filed: full replacement per period.
   * Additive `previouslyReportedTotTeBetCents`: the period's TotTeBet (× 100) as last reported in a
   * return for an earlier period (or the original return) — the base of the saldo (GS §2.4.1).
   */
  corrections: Array<{ period: { start: string; end: string }; ikvs: LoonaangifteIkv[]; previouslyReportedTotTeBetCents?: number | null }>;
  /** ISO date-time. */
  createdAt: string;
  /** Unique message id for this submission. */
  messageId: string;
  /** Additive: `aanvullend` sends an AanvullendeAangifte (GS §2.3.2) instead of a VolledigeAangifte. */
  kind?: 'volledig' | 'aanvullend';
}

export interface LoonaangifteResult {
  file: GeneratedFile;
  /** Totals of the return in cents, keyed by the spec's element names. */
  summary: Record<string, number>;
  /** What the employer pays for this return (including corrections), cents. */
  amountDueCents: number;
  issues: PayrollIssue[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Elfproef of GS conditions 0014.1 / 0045: a8 = (9·a0 + 8·a1 + … + 2·a7) mod 11. */
export function elfproef(nineDigits: string): boolean {
  if (!/^\d{9}$/.test(nineDigits)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += (9 - i) * Number(nineDigits[i]);
  return sum % 11 === Number(nineDigits[8]);
}

/** BSN: 9 digits (leading zeros), elfproef, not all of the first three zero, first digit not 8 or 9 (GS 5.2). */
export function isValidBsn(bsn: string | null | undefined): boolean {
  if (!bsn) return false;
  const digits = bsn.replace(/\D/g, '').padStart(9, '0');
  if (digits.length !== 9 || digits.startsWith('000')) return false;
  if (digits[0] === '8' || digits[0] === '9') return false;
  return elfproef(digits);
}

/** Loonheffingennummer `123456789L01` (GS 3.2: pattern of the XSD and elfproef on the fiscal number). */
export function isValidLoonheffingennummer(lhnr: string | null | undefined): boolean {
  if (!lhnr) return false;
  const m = /^(\d{9})L(\d{2})$/.exec(lhnr.trim().toUpperCase());
  if (!m || m[2] === '00' || m[1]!.startsWith('000')) return false;
  return elfproef(m[1]!);
}

/**
 * The 16-digit betalingskenmerk of a monthly loonheffingen return ([BK]):
 * check digit, positions 1–8 of the fiscal number, `6` (loonaangifte), last
 * digit of the year, the 2-digit subnummer, the period (01–12) and `0`. The
 * check digit is 11 minus the weighted sum mod 11 (weights 2, 4, 8, 5, 10, 9,
 * 7, 3, 6, 1 from the right, repeating); 10 → 1, 11 → 0.
 */
export function betalingskenmerk(args: { loonheffingennummer: string; taxYear: number; month: number }): string | null {
  const m = /^(\d{9})L(\d{2})$/.exec(args.loonheffingennummer.trim().toUpperCase());
  if (!m || args.month < 1 || args.month > 12) return null;
  const body = `${m[1]!.slice(0, 8)}6${args.taxYear % 10}${m[2]}${String(args.month).padStart(2, '0')}0`;
  const weights = [2, 4, 8, 5, 10, 9, 7, 3, 6, 1];
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * weights[i % weights.length]!;
  }
  let check = 11 - (sum % 11);
  if (check === 10) check = 1;
  if (check === 11) check = 0;
  return `${check}${body}`;
}

/**
 * Filing and payment deadline of a monthly return: the last day of the next
 * month ([TV]: e.g. period 6030 (March 2026) → 30 April 2026; 6120 → 31 January 2027).
 */
export function loonaangifteDueDate(taxYear: number, month: number): string {
  const y = month === 12 ? taxYear + 1 : taxYear;
  const m = month === 12 ? 1 : month + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Summing payslips
// ---------------------------------------------------------------------------

const AMOUNT_KEYS = [
  'loonLbPh', 'loonSv', 'premieloonAwf', 'premieloonAof', 'premieloonWhk', 'loonZvw', 'loonTabelBijzondereBeloningen',
  'wageTax', 'labourCredit', 'awfPremium', 'aofPremium', 'wkoPremium', 'whkPremium', 'zvwEmployerLevy', 'zvwWithheld',
  'holidayAllowancePaid', 'holidayAllowanceAccrued', 'companyCarValue', 'companyCarEmployeeContribution',
  'pensionEmployee', 'taxFreeAllowances',
] as const;
const OPTIONAL_AMOUNT_KEYS = [
  'cashWage', 'inKindWage', 'overtimeWage', 'travelAllowanceTaxFree', 'transitionPayment', 'transitionPaymentWageTax',
  'transitionPaymentLoonZvw', 'transitionPaymentZvw',
] as const;

/**
 * Add up several payslips' filing data for one income relationship and period
 * (e.g. the regular run plus an off-cycle run). Amounts and hours add up;
 * indicators come from the last payslip; the contract wage and hours are the
 * last payslip's (they describe the situation at the end of the period).
 */
export function sumNlFilingData(items: NlFilingData[]): NlFilingData {
  if (items.length === 0) throw new Error('sumNlFilingData needs at least one payslip');
  const last = items[items.length - 1]!;
  const amounts = { ...last.amounts };
  for (const key of AMOUNT_KEYS) amounts[key] = items.reduce((s, i) => s + i.amounts[key], 0);
  for (const key of OPTIONAL_AMOUNT_KEYS) {
    if (items.some((i) => i.amounts[key] !== undefined)) amounts[key] = items.reduce((s, i) => s + (i.amounts[key] ?? 0), 0);
  }
  // A period with tijdvakloon in any payslip uses that payslip's period table code.
  const withPeriodTable = [...items].reverse().find((i) => i.tableCode !== '010');
  return {
    ...last,
    tableCode: withPeriodTable?.tableCode ?? last.tableCode,
    amounts,
    hoursPaid: items.reduce((s, i) => s + i.hoursPaid, 0),
    svDays: items.reduce((s, i) => s + i.svDays, 0),
    incidentalIncomeReduction: [...items].reverse().find((i) => i.incidentalIncomeReduction)?.incidentalIncomeReduction ?? null,
  };
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** Werknemersgegevens amounts, N(10,2): a decimal point, no thousands separator (GS §"Specificaties"). */
function amt(cents: number): string {
  const c = Math.round(cents);
  return c % 100 === 0 ? String(c / 100) : fromCents(c);
}

/** Collective amounts are whole euros, "afgerond (of afgekapt) in het voordeel van de inhoudingsplichtige" (GS §4.1): truncated. */
function euros(cents: number): number {
  return Math.trunc(cents / 100);
}

function hoursText(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(2);
}

interface IkvFigures {
  numIv: number;
  srtIv: '15' | '17' | '62';
  datAanv: string;
  datEind: string | null;
  endReason: string | null;
  periods: Array<{ start: string; ww: boolean; wao: boolean; zw: boolean }>;
  f: NlFilingData;
  /** Overrides for the transitievergoeding IKV. */
  amounts: Record<string, number>;
}

const WG_FIELDS = [
  'LnLbPh', 'LnSV', 'PrlnAofAnwLg', 'PrlnAofAnwHg', 'PrlnAofAnwUit', 'PrlnWhkAnw', 'PrlnAwfAnwLg', 'PrlnAwfAnwHg',
  'PrlnAwfAnwHz', 'PrlnAwfAnwUit', 'PrLnUfo', 'LnTabBB', 'VakBsl', 'OpgRchtVakBsl', 'OpnAvwb', 'OpbAvwb', 'LnInGld',
  'WrdLn', 'LnOwrk', 'VerstrAanv', 'IngLbPh', 'PrAofLg', 'PrAofHg', 'PrAofUit', 'OpslWko', 'PrGediffWhk', 'PrAwfLg',
  'PrAwfHg', 'PrAwfHz', 'PrAwfUit', 'PrUFO', 'BijdrZvw', 'WghZvw', 'WrdPrGebrAut', 'WrknBijdrAut', 'Reisk', 'VerrArbKrt',
] as const;
type WgField = (typeof WG_FIELDS)[number];

/** Werknemersgegevens amounts of a regular income relationship (cents), excluding a transitievergoeding. */
function regularAmounts(f: NlFilingData): Record<WgField, number> {
  const a = f.amounts;
  const tp = a.transitionPayment ?? 0;
  const tpTax = a.transitionPaymentWageTax ?? 0;
  const tpZvw = a.transitionPaymentZvw ?? 0;
  const inKind = a.inKindWage ?? a.companyCarValue - a.companyCarEmployeeContribution;
  const loonLb = a.loonLbPh - tp;
  const cash = a.cashWage !== undefined ? a.cashWage - tp : loonLb - inKind + a.pensionEmployee;
  const low = (rate: 'low' | 'high', v: number) => (rate === 'low' ? v : 0);
  const high = (rate: 'low' | 'high', v: number) => (rate === 'high' ? v : 0);
  return {
    LnLbPh: loonLb,
    LnSV: a.loonSv,
    PrlnAofAnwLg: low(f.aofRate, a.premieloonAof),
    PrlnAofAnwHg: high(f.aofRate, a.premieloonAof),
    PrlnAofAnwUit: 0,
    PrlnWhkAnw: a.premieloonWhk,
    PrlnAwfAnwLg: low(f.awfRate, a.premieloonAwf),
    PrlnAwfAnwHg: high(f.awfRate, a.premieloonAwf),
    PrlnAwfAnwHz: 0,
    PrlnAwfAnwUit: 0,
    PrLnUfo: 0,
    LnTabBB: a.loonTabelBijzondereBeloningen - tp,
    VakBsl: a.holidayAllowancePaid,
    OpgRchtVakBsl: a.holidayAllowanceAccrued,
    OpnAvwb: 0,
    OpbAvwb: 0,
    LnInGld: cash,
    WrdLn: inKind,
    LnOwrk: a.overtimeWage ?? 0,
    VerstrAanv: 0,
    IngLbPh: a.wageTax - tpTax,
    PrAofLg: low(f.aofRate, a.aofPremium),
    PrAofHg: high(f.aofRate, a.aofPremium),
    PrAofUit: 0,
    OpslWko: a.wkoPremium,
    PrGediffWhk: a.whkPremium,
    PrAwfLg: low(f.awfRate, a.awfPremium),
    PrAwfHg: high(f.awfRate, a.awfPremium),
    PrAwfHz: 0,
    PrAwfUit: 0,
    PrUFO: 0,
    BijdrZvw: a.zvwWithheld - (f.isDga ? tpZvw : 0),
    WghZvw: a.zvwEmployerLevy - (f.isDga ? 0 : tpZvw),
    WrdPrGebrAut: a.companyCarValue,
    WrknBijdrAut: a.companyCarEmployeeContribution,
    Reisk: a.travelAllowanceTaxFree ?? 0,
    VerrArbKrt: a.labourCredit,
  };
}

function transitionAmounts(f: NlFilingData): Record<WgField, number> {
  const a = f.amounts;
  const tp = a.transitionPayment ?? 0;
  const zero = Object.fromEntries(WG_FIELDS.map((k) => [k, 0])) as Record<WgField, number>;
  return {
    ...zero,
    LnLbPh: tp,
    LnTabBB: tp,
    LnInGld: tp,
    IngLbPh: a.transitionPaymentWageTax ?? 0,
    BijdrZvw: f.isDga ? a.transitionPaymentZvw ?? 0 : 0,
    WghZvw: f.isDga ? 0 : a.transitionPaymentZvw ?? 0,
  };
}

interface BuiltPeriod {
  ikvNodes: XmlNode[];
  totals: Record<string, number>;
}

/** Collective totals in whole euros, in XSD order (CollectieveAangifteType). */
const COLLECTIVE_ORDER = [
  'TotLnLbPh', 'TotLnSV', 'TotPrlnAofAnwLg', 'TotPrlnAofAnwHg', 'TotPrlnAofAnwUit', 'TotPrlnWhkAnw', 'TotPrlnAwfAnwLg',
  'TotPrlnAwfAnwHg', 'TotPrlnAwfAnwHz', 'TotPrlnAwfAnwUit', 'PrLnUFO', 'IngLbPh', 'TotPrAofLg', 'TotPrAofHg', 'TotPrAofUit',
  'TotOpslWko', 'TotPrGediffWhk', 'TotPrAwfLg', 'TotPrAwfHg', 'TotPrAwfHz', 'TotPrAwfUit', 'PrUFO', 'IngBijdrZvw',
  'TotWghZvw', 'TotTeBet',
] as const;

/** Which werknemersgegevens rubriek each collective total sums (GS §4.1 conditions 0001–0012, 2003…). */
const COLLECTIVE_SOURCES: Record<string, WgField> = {
  TotLnLbPh: 'LnLbPh', TotLnSV: 'LnSV', TotPrlnAofAnwLg: 'PrlnAofAnwLg', TotPrlnAofAnwHg: 'PrlnAofAnwHg',
  TotPrlnAofAnwUit: 'PrlnAofAnwUit', TotPrlnWhkAnw: 'PrlnWhkAnw', TotPrlnAwfAnwLg: 'PrlnAwfAnwLg', TotPrlnAwfAnwHg: 'PrlnAwfAnwHg',
  TotPrlnAwfAnwHz: 'PrlnAwfAnwHz', TotPrlnAwfAnwUit: 'PrlnAwfAnwUit', PrLnUFO: 'PrLnUfo', IngLbPh: 'IngLbPh',
  TotPrAofLg: 'PrAofLg', TotPrAofHg: 'PrAofHg', TotPrAofUit: 'PrAofUit', TotOpslWko: 'OpslWko', TotPrGediffWhk: 'PrGediffWhk',
  TotPrAwfLg: 'PrAwfLg', TotPrAwfHg: 'PrAwfHg', TotPrAwfHz: 'PrAwfHz', TotPrAwfUit: 'PrAwfUit', PrUFO: 'PrUFO',
  IngBijdrZvw: 'BijdrZvw', TotWghZvw: 'WghZvw',
};

/** Totals whose sum makes TotTeBet (GS condition 2315). */
const PAYABLE = [
  'IngLbPh', 'TotWghZvw', 'IngBijdrZvw', 'TotPrAofLg', 'TotPrAofHg', 'TotPrAofUit', 'TotOpslWko', 'TotPrGediffWhk',
  'TotPrAwfLg', 'TotPrAwfHg', 'TotPrAwfHz', 'TotPrAwfUit', 'PrUFO',
];

/** Optional collective elements written only when not zero (premium totals are optional in the XSD). */
const OPTIONAL_COLLECTIVE = new Set([
  'TotPrAofLg', 'TotPrAofHg', 'TotPrAofUit', 'TotOpslWko', 'TotPrGediffWhk', 'TotPrAwfLg', 'TotPrAwfHg', 'TotPrAwfHz', 'TotPrAwfUit', 'PrUFO',
]);

export function buildLoonaangifte(input: LoonaangifteInput): LoonaangifteResult {
  const issues: PayrollIssue[] = [];
  const err = (code: string, params?: Record<string, string | number>) => issues.push({ severity: 'error', code, ...(params ? { params } : {}) });
  const warn = (code: string, params?: Record<string, string | number>) => issues.push({ severity: 'warning', code, ...(params ? { params } : {}) });

  const year = input.taxYear;
  const rules = nlRulesForYear(year);
  // One XSD per year; 2026 and 2027 are implemented (see the file header for the 2027 differences).
  if (!rules || ![2026, 2027].includes(year)) err('unsupported_tax_year', { year });
  const lhnr = input.employer.loonheffingennummer.trim().toUpperCase();
  if (!isValidLoonheffingennummer(lhnr)) err('invalid_loonheffingennummer', { loonheffingennummer: input.employer.loonheffingennummer });
  if (!input.employer.contactName) err('employer_incomplete', { field: 'contactName' });
  const phone = (input.employer.contactPhone ?? '').replace(/^00/, '+').replace(/[^\d+]/g, '');
  if (!phone) err('employer_incomplete', { field: 'contactPhone' });
  const relNr = (input.software.relationNumber ?? '').trim().toUpperCase();
  if (!/^SWO\d{5}$/.test(relNr)) err('missing_software_relation_number');
  if (input.corrections.length > 13) err('too_many_corrections', { count: input.corrections.length });

  const checkPeriod = (p: { start: string; end: string }) => {
    const ok = p.start.slice(0, 4) === String(year) && p.start.endsWith('-01') && p.end === monthEnd(p.start);
    if (!ok) err('invalid_period', { start: p.start, end: p.end });
  };
  checkPeriod(input.period);

  const buildPeriod = (period: { start: string; end: string }, ikvs: LoonaangifteIkv[]): BuiltPeriod => {
    checkPeriod(period);
    const rows: Array<{ ikv: LoonaangifteIkv; fig: IkvFigures }> = [];
    for (const ikv of ikvs) {
      const f = ikv.filing;
      const id = ikv.identity;
      const anonymous = f.anonymous || f.tableCode === '940';
      if (!anonymous && !isValidBsn(id.bsn)) {
        if (!id.bsn) err('missing_tax_id', { incomeRelationship: ikv.incomeRelationshipNumber });
        else err('invalid_bsn', { incomeRelationship: ikv.incomeRelationshipNumber });
      }
      if (anonymous && !id.bsn && !id.personnelNumber) err('missing_personnel_number', { incomeRelationship: ikv.incomeRelationshipNumber });
      if (!anonymous && (!id.address || !id.address.street || !id.address.city)) err('missing_address', { incomeRelationship: ikv.incomeRelationshipNumber });

      const ended = !!ikv.employmentEnd && ikv.employmentEnd <= period.end;
      let endReason: string | null = null;
      if (ended) {
        endReason = ikv.endReasonCode ?? null;
        if (!endReason) {
          endReason = '99';
          warn('end_reason_defaulted', { incomeRelationship: ikv.incomeRelationshipNumber });
        }
      }
      // Inkomstenperiode(s): split at the AOW date when it falls inside the period (GS IndWAO/IndWW, conditions 1314/1315).
      const startInPeriod = ikv.employmentStart > period.start ? ikv.employmentStart : period.start;
      const periods: IkvFigures['periods'] = [{ start: startInPeriod, ww: f.insured.ww, wao: f.insured.wao, zw: f.insured.zw }];
      if (rules && id.dateOfBirth && (f.insured.ww || f.insured.wao)) {
        const aow = nlAowDate(id.dateOfBirth, rules);
        if (aow > startInPeriod && aow <= period.end) periods.push({ start: aow, ww: false, wao: false, zw: f.insured.zw });
      }
      rows.push({
        ikv,
        fig: {
          numIv: ikv.incomeRelationshipNumber,
          srtIv: f.isDga ? '17' : '15',
          datAanv: ikv.employmentStart,
          datEind: ended ? ikv.employmentEnd : null,
          endReason,
          periods,
          f,
          amounts: regularAmounts(f),
        },
      });
      const tp = f.amounts.transitionPayment ?? 0;
      if (tp !== 0) {
        if (ikv.transitionPaymentIncomeRelationshipNumber === null || ikv.transitionPaymentIncomeRelationshipNumber === undefined) {
          err('missing_income_relationship_number', { incomeRelationship: ikv.incomeRelationshipNumber, reason: 'transition_payment' });
        } else {
          rows.push({
            ikv,
            fig: {
              numIv: ikv.transitionPaymentIncomeRelationshipNumber,
              srtIv: '62',
              datAanv: startInPeriod,
              datEind: null,
              endReason: null,
              periods: [{ start: startInPeriod, ww: false, wao: false, zw: false }],
              f,
              amounts: transitionAmounts(f),
            },
          });
        }
      }
    }

    const nodes = rows.map(({ ikv, fig }) => ikvNode(ikv, fig, input, period, issues));
    const sums: Record<string, number> = {};
    for (const [total, field] of Object.entries(COLLECTIVE_SOURCES)) {
      sums[total] = euros(rows.reduce((s, r) => s + r.fig.amounts[field], 0));
    }
    sums.TotTeBet = PAYABLE.reduce((s, k) => s + (sums[k] ?? 0), 0);
    return { ikvNodes: nodes, totals: sums };
  };

  const current = buildPeriod(input.period, input.ikvs);
  const corrections = input.corrections.map((c) => {
    if (c.period.start >= input.period.start) err('invalid_correction_period', { start: c.period.start });
    const built = buildPeriod(c.period, c.ikvs);
    let saldo = 0;
    if (c.previouslyReportedTotTeBetCents === null || c.previouslyReportedTotTeBetCents === undefined) {
      err('correction_saldo_unknown', { start: c.period.start });
    } else {
      saldo = built.totals.TotTeBet! - Math.trunc(c.previouslyReportedTotTeBetCents / 100);
    }
    return { c, built, saldo };
  });
  const seen = new Set<string>();
  for (const { c } of corrections) {
    if (seen.has(c.period.start)) err('duplicate_correction_period', { start: c.period.start });
    seen.add(c.period.start);
  }

  const collective = (totals: Record<string, number>, extra: XmlNode[] = []): XmlNode[] => {
    const out: XmlNode[] = [];
    for (const key of COLLECTIVE_ORDER) {
      const v = totals[key] ?? 0;
      if (OPTIONAL_COLLECTIVE.has(key) && v === 0) continue;
      out.push(el(key, v));
    }
    return [...out, ...extra];
  };

  const saldoNodes = corrections.map(({ c, saldo }) => el('SaldoCorrectiesVoorgaandTijdvak', [el('DatAanvTv', c.period.start), el('DatEindTv', c.period.end), el('Saldo', saldo)]));
  const totGen = current.totals.TotTeBet! + corrections.reduce((s, x) => s + x.saldo, 0);
  const wrapper = input.kind === 'aanvullend' ? 'AanvullendeAangifte' : 'VolledigeAangifte';

  const tijdvakAangifte = el('TijdvakAangifte', [
    el('DatAanvTv', input.period.start),
    el('DatEindTv', input.period.end),
    el(wrapper, [el('CollectieveAangifte', collective(current.totals, [...saldoNodes, el('TotGen', totGen)])), ...current.ikvNodes]),
  ]);
  const tijdvakCorrecties = corrections.map(({ c, built }) =>
    el('TijdvakCorrectie', [el('DatAanvTv', c.period.start), el('DatEindTv', c.period.end), el('CollectieveAangifte', collective(built.totals)), ...built.ikvNodes]),
  );

  const root = el(
    'Loonaangifte',
    [
      el('Bericht', [
        el('IdBer', input.messageId.slice(0, 32)),
        el('DatTdAanm', input.createdAt.slice(0, 19)),
        el('ContPers', (input.employer.contactName ?? '').slice(0, 35)),
        el('TelNr', phone.slice(0, 25)),
        el('RelNr', relNr),
        el('GebrSwPakket', `${input.software.name} ${input.software.version}`.trim().slice(0, 27)),
      ]),
      el('AdministratieveEenheid', [el('LhNr', lhnr), el('NmIP', input.employer.name.slice(0, 200)), tijdvakAangifte, ...tijdvakCorrecties]),
    ],
    { xmlns: `http://xml.belastingdienst.nl/schemas/Loonaangifte/${year}/01`, version: '2.0' },
  );
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(root)}\n`;

  const summary: Record<string, number> = {};
  for (const [k, v] of Object.entries(current.totals)) summary[k] = v * 100;
  corrections.forEach(({ c, saldo }) => {
    summary[`Saldo:${c.period.start}`] = saldo * 100;
  });
  summary.TotGen = totGen * 100;

  const month = Number(input.period.start.slice(5, 7));
  return {
    file: {
      fileName: `loonaangifte-${lhnr}-${year}-${String(month).padStart(2, '0')}.xml`,
      contentType: 'application/xml',
      content,
    },
    summary,
    amountDueCents: totGen * 100,
    issues,
  };
}

/** Last day of the month that starts on `start` (monthly aangiftetijdvak). */
function monthEnd(start: string): string {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${start.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

function ikvNode(ikv: LoonaangifteIkv, fig: IkvFigures, input: LoonaangifteInput, period: { start: string; end: string }, issues: PayrollIssue[]): XmlNode {
  const f = fig.f;
  const id = ikv.identity;
  const anonymous = f.anonymous || f.tableCode === '940';
  const yn = (b: boolean) => (b ? 'J' : 'N');

  // NatuurlijkPersoon (GS 5.2–5.4).
  const person: XmlNode[] = [];
  const bsn = id.bsn ? id.bsn.replace(/\D/g, '').padStart(9, '0') : null;
  if (bsn) person.push(el('SofiNr', bsn));
  const initials = (id.initials ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  if (initials) person.push(el('Voorl', initials));
  if (id.surnamePrefix) person.push(el('Voorv', id.surnamePrefix.slice(0, 10)));
  if (id.surname) person.push(el('SignNm', id.surname.slice(0, 200)));
  if (id.dateOfBirth) person.push(el('Gebdat', id.dateOfBirth));
  if (!anonymous || bsn) {
    const nat = brpNationalityCode(id.nationality);
    if (!nat.known) issues.push({ severity: 'warning', code: 'nationality_unknown', params: { incomeRelationship: ikv.incomeRelationshipNumber, nationality: id.nationality ?? '' } });
    person.push(el('Nat', nat.code));
    person.push(el('Gesl', id.gender ?? 9));
  }
  const a = id.address;
  if (a && a.street && a.city) {
    const country = (a.country ?? 'NL').toUpperCase();
    const m = /^(\d+)\s*(.*)$/.exec((a.houseNumber ?? '').trim());
    if (country === 'NL') {
      const pc = (a.postalCode ?? '').toUpperCase().replace(/\s/g, '');
      if (!/^[1-9]\d{3}[A-Z]{2}$/.test(pc)) issues.push({ severity: 'error', code: 'invalid_postal_code', params: { incomeRelationship: ikv.incomeRelationshipNumber } });
      const addition = (a.houseNumberAddition ?? m?.[2] ?? '').trim();
      person.push(
        el('AdresBinnenland', [
          el('Str', a.street.slice(0, 24)),
          ...(m ? [el('HuisNr', Number(m[1]))] : []),
          ...(m && addition ? [el('HuisNrToev', addition.slice(0, 4))] : []),
          el('Pc', pc),
          el('Woonpl', a.city.slice(0, 24)),
        ]),
      );
    } else {
      person.push(
        el('AdresBuitenland', [
          el('Str', a.street.slice(0, 24)),
          ...(a.houseNumber ? [el('HuisNr', `${a.houseNumber}${a.houseNumberAddition ? ` ${a.houseNumberAddition}` : ''}`.slice(0, 9))] : []),
          ...(a.postalCode ? [el('Pc', a.postalCode.slice(0, 9))] : []),
          el('Woonpl', a.city.slice(0, 24)),
          el('LandCd', country),
        ]),
      );
    }
  }

  const regular = fig.srtIv === '15';
  const insuredAny = f.insured.ww || f.insured.zw || f.insured.wao;
  const periods = fig.periods.map((p) =>
    el('Inkomstenperiode', [
      el('DatAanv', p.start),
      el('SrtIV', fig.srtIv),
      ...(regular ? [el('CdAard', 1)] : []),
      ...(fig.srtIv !== '62' ? [el('CAO', ikv.caoCode ?? 9999)] : []),
      ...(regular
        ? [el('IndArbovOnbepTd', yn(f.contract.indefinite)), el('IndSchriftArbov', yn(f.contract.written)), el('IndOprov', yn(f.contract.onCall))]
        : []),
      el('IndLhKort', yn(f.applyLoonheffingskorting)),
      el('LbTab', fig.srtIv === '62' ? '020' : f.tableCode),
      el('IndWAO', yn(p.wao)),
      el('IndWW', yn(p.ww)),
      el('IndZW', yn(p.zw)),
      el('CdZvw', f.isDga || f.zvw === 'withheld' ? 'M' : 'K'),
      ...(fig.srtIv !== '62' && f.incidentalIncomeReduction ? [el('CdIncInkVerm', f.incidentalIncomeReduction)] : []),
    ]),
  );

  const am = fig.amounts;
  const wg: XmlNode[] = WG_FIELDS.map((k) => el(k, amt(am[k])));
  const verlU = fig.srtIv === '62' ? 0 : Math.round(f.hoursPaid);
  wg.push(el('AantVerlU', verlU));
  if (fig.srtIv !== '62') {
    wg.push(el('Ctrctln', amt(f.amounts.contractWage ?? 0)));
    wg.push(el('AantCtrcturenPWk', hoursText(f.contractHoursPerWeek ?? 0)));
  }
  wg.push(el('BedrRntKstvPersl', '0'));

  const sector: XmlNode[] = [];
  if (insuredAny && fig.srtIv === '15') {
    const sect = input.employer.sectorCode;
    if (sect === null || sect === undefined) {
      issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'sectorCode' } });
    } else {
      const start = ikv.employmentStart > period.start ? ikv.employmentStart : period.start;
      sector.push(
        el('Sector', [
          el('DatAanvSect', start),
          ...(fig.datEind && fig.datEind < period.end ? [el('DatEindSect', fig.datEind)] : []),
          el('Sect', sect),
        ]),
      );
    }
  }

  return el('InkomstenverhoudingInitieel', [
    el('NumIV', fig.numIv),
    el('DatAanv', fig.datAanv),
    ...(fig.datEind ? [el('DatEind', fig.datEind)] : []),
    ...(fig.endReason ? [el('CdRdnEindArbov', fig.endReason)] : []),
    ...(id.personnelNumber ? [el('PersNr', id.personnelNumber.slice(0, 35))] : []),
    el('NatuurlijkPersoon', person),
    ...periods,
    el('Werknemersgegevens', wg),
    ...sector,
  ]);
}

// ---------------------------------------------------------------------------
// Printable summary
// ---------------------------------------------------------------------------

const SUMMARY_LABELS: Array<[string, { en: string; nl: string }]> = [
  ['TotLnLbPh', { en: 'Total wage for wage tax', nl: 'Totaal loon LB/PH' }],
  ['TotLnSV', { en: 'Total wage for employee insurances', nl: 'Totaal loon SV' }],
  ['TotPrlnAwfAnwLg', { en: 'Premium wage AWf low', nl: 'Aanwas premieloon AWf laag' }],
  ['TotPrlnAwfAnwHg', { en: 'Premium wage AWf high', nl: 'Aanwas premieloon AWf hoog' }],
  ['TotPrlnAofAnwLg', { en: 'Premium wage Aof low', nl: 'Aanwas premieloon Aof laag' }],
  ['TotPrlnAofAnwHg', { en: 'Premium wage Aof high', nl: 'Aanwas premieloon Aof hoog' }],
  ['TotPrlnWhkAnw', { en: 'Premium wage Whk', nl: 'Aanwas premieloon Whk' }],
  ['IngLbPh', { en: 'Wage tax withheld', nl: 'Ingehouden loonbelasting/premie volksverzekeringen' }],
  ['TotPrAwfLg', { en: 'AWf premium low', nl: 'Premie AWf laag' }],
  ['TotPrAwfHg', { en: 'AWf premium high', nl: 'Premie AWf hoog' }],
  ['TotPrAofLg', { en: 'Aof premium low', nl: 'Premie Aof laag' }],
  ['TotPrAofHg', { en: 'Aof premium high', nl: 'Premie Aof hoog' }],
  ['TotOpslWko', { en: 'Wko surcharge', nl: 'Opslag Wko' }],
  ['TotPrGediffWhk', { en: 'Whk premium', nl: 'Gedifferentieerde premie Whk' }],
  ['IngBijdrZvw', { en: 'Zvw contribution withheld', nl: 'Ingehouden bijdrage Zvw' }],
  ['TotWghZvw', { en: 'Employer Zvw levy', nl: 'Werkgeversheffing Zvw' }],
  ['TotTeBet', { en: 'Total payable for the period', nl: 'Totaal te betalen over tijdvak' }],
];

const euroText = (cents: number, lang: 'en' | 'nl') => {
  const s = fromCents(Math.abs(cents)).split('.');
  const whole = s[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'nl' ? '.' : ',');
  return `${cents < 0 ? '-' : ''}€ ${whole}${lang === 'nl' ? ',' : '.'}${s[1]}`;
};

/** A printable summary of the return (totals per premium and tax). */
export function loonaangifteSummaryDocument(result: LoonaangifteResult, input: LoonaangifteInput, lang: 'en' | 'nl'): PayrollDocument {
  const nl = lang === 'nl';
  const month = Number(input.period.start.slice(5, 7));
  const due = loonaangifteDueDate(input.taxYear, month);
  const kenmerk = betalingskenmerk({ loonheffingennummer: input.employer.loonheffingennummer, taxYear: input.taxYear, month });
  const s = result.summary;
  const rows = SUMMARY_LABELS.filter(([k]) => (s[k] ?? 0) !== 0 || k === 'TotTeBet').map(([k, l]) => [l[lang], k, euroText(s[k] ?? 0, lang)]);
  const saldi = Object.entries(s)
    .filter(([k]) => k.startsWith('Saldo:'))
    .map(([k, v]) => [nl ? `Saldo correctie ${k.slice(6, 13)}` : `Correction balance ${k.slice(6, 13)}`, 'Saldo', euroText(v, lang)]);
  return {
    title: nl ? 'Aangifte loonheffingen' : 'Payroll tax return',
    subtitle: `${input.period.start} – ${input.period.end}`,
    language: lang,
    from: [input.employer.name, `${nl ? 'Loonheffingennummer' : 'Payroll tax number'}: ${input.employer.loonheffingennummer}`],
    sections: [
      {
        kind: 'fields',
        fields: [
          { label: nl ? 'Aangiftetijdvak' : 'Period', value: `${input.period.start} – ${input.period.end}` },
          { label: nl ? 'Inkomstenverhoudingen' : 'Income relationships', value: String(input.ikvs.length) },
          { label: nl ? 'Correcties' : 'Corrections', value: String(input.corrections.length) },
          { label: nl ? 'Uiterste aangifte- en betaaldatum' : 'Filing and payment deadline', value: due },
          { label: nl ? 'Betalingskenmerk' : 'Payment reference', value: kenmerk ?? '—' },
          { label: nl ? 'Te betalen (totaal generaal)' : 'Amount due (total)', value: euroText(result.amountDueCents, lang), emphasis: true },
        ],
      },
      {
        kind: 'table',
        title: nl ? 'Collectieve aangifte' : 'Totals',
        columns: [nl ? 'Rubriek' : 'Item', nl ? 'Code' : 'Element', nl ? 'Bedrag' : 'Amount'],
        alignRight: [2],
        rows: [...rows, ...saldi],
        totals: [nl ? 'Totaal generaal' : 'Total', 'TotGen', euroText(result.amountDueCents, lang)],
      },
    ],
    footer: [nl ? 'Bedragen in hele euro’s zoals aangegeven.' : 'Amounts in whole euros as filed.'],
    watermark: result.issues.some((i) => i.severity === 'error') ? (nl ? 'CONCEPT' : 'DRAFT') : null,
  };
}
