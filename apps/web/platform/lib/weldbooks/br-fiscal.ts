/**
 * Brazilian fiscal fields of invoices, bills and recurring templates: NCM and
 * CFOP on every line (plus origin, ICMS / IPI / ISS overrides and the LC 116
 * service code), and per document the withholdings (ISS, IRRF, CSRF, INSS) and
 * the buyer's ICMS status. Mirrors `BrLineFiscalData` / `BrDocumentFiscalData`
 * of `@weldsuite/books-domain/jurisdictions/br` (the platform doesn't import
 * the domain package) and the request schemas of `books-api`
 * (`lib/br-fiscal-schemas.ts`).
 *
 * Nothing here calculates tax: the server does, from these inputs.
 */
import { z } from 'zod';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';

export const BR_ORIGINS = ['0', '1', '2', '3', '4', '5', '6', '7', '8'] as const;
export type BrOrigin = (typeof BR_ORIGINS)[number];

/** A document line's Brazilian fields, as form state (strings a controlled input can bind to). */
export interface BrLineValues {
  /** Mercosul nomenclature of goods: 8 digits. */
  ncm: string;
  /** Fiscal operation code: 4 digits, first 1 to 7. */
  cfop: string;
  /** NF-e origin of the goods, '' = not set. */
  brOrigin: '' | BrOrigin;
  brIcmsRate: string;
  brIpiRate: string;
  brIssRate: string;
  /** LC 116/2003 service item, e.g. 01.07. */
  brServiceCode: string;
  /** CEST: 7 digits. */
  brCest: string;
}

export const EMPTY_BR_LINE: BrLineValues = {
  ncm: '',
  cfop: '',
  brOrigin: '',
  brIcmsRate: '',
  brIpiRate: '',
  brIssRate: '',
  brServiceCode: '',
  brCest: '',
};

/** The Zod fields of {@link BrLineValues}; spread into a line schema, then `.superRefine(brLineChecks(...))`. */
export const brLineFields = {
  ncm: z.string().default(''),
  cfop: z.string().default(''),
  brOrigin: z.enum(['', ...BR_ORIGINS]).default(''),
  brIcmsRate: z.string().default(''),
  brIpiRate: z.string().default(''),
  brIssRate: z.string().default(''),
  brServiceCode: z.string().default(''),
  brCest: z.string().default(''),
};

export interface BrLineMessages {
  ncm: string;
  cfop: string;
  cest: string;
  /** A percentage between 0 and 100. */
  percent: string;
  /** The ISS rate is at most 5. */
  issRate: string;
}

function parseRate(value: string): number | undefined {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Why a line's BR fields are not valid: a map of field name to the message of `messages`. */
export function brLineProblems(line: Partial<BrLineValues>, messages: BrLineMessages): Partial<Record<keyof BrLineValues, string>> {
  const problems: Partial<Record<keyof BrLineValues, string>> = {};
  if (line.ncm?.trim() && !/^\d{8}$/.test(line.ncm.trim())) problems.ncm = messages.ncm;
  if (line.cfop?.trim() && !/^[1-7]\d{3}$/.test(line.cfop.trim())) problems.cfop = messages.cfop;
  if (line.brCest?.trim() && !/^\d{7}$/.test(line.brCest.trim())) problems.brCest = messages.cest;
  for (const key of ['brIcmsRate', 'brIpiRate'] as const) {
    const n = parseRate(line[key] ?? '');
    if (n !== undefined && (Number.isNaN(n) || n < 0 || n > 100)) problems[key] = messages.percent;
  }
  const iss = parseRate(line.brIssRate ?? '');
  if (iss !== undefined && (Number.isNaN(iss) || iss < 0 || iss > 5)) problems.brIssRate = messages.issRate;
  return problems;
}

/** Refinement of a line schema: NCM, CFOP, CEST and the rate overrides must be well formed. */
export function brLineChecks(messages: BrLineMessages) {
  return (line: Partial<BrLineValues>, ctx: z.RefinementCtx) => {
    for (const [field, message] of Object.entries(brLineProblems(line, messages))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  };
}

/** The line fields of a stored document line, as form state. */
export function brLineValuesFromStored(item: {
  ncm?: string | null;
  cfop?: string | null;
  fiscalData?: Record<string, unknown> | null;
}): BrLineValues {
  const f = item.fiscalData ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const origin = str(f.origin);
  return {
    ncm: item.ncm ?? '',
    cfop: item.cfop ?? '',
    brOrigin: (BR_ORIGINS as readonly string[]).includes(origin) ? (origin as BrOrigin) : '',
    brIcmsRate: num(f.icmsRate),
    brIpiRate: num(f.ipiRate),
    brIssRate: num(f.issRate),
    brServiceCode: str(f.serviceCode),
    brCest: str(f.cest),
  };
}

/** The line fiscal data a create / update body sends (the server's schema is strict: only these keys). */
export type BrLineFiscalPayload = {
  cest?: string;
  origin?: BrOrigin;
  icmsRate?: number;
  ipiRate?: number;
  issRate?: number;
  serviceCode?: string;
};

/** The Brazilian part of a line body: `null`s clear what a stored line held. */
export function brLinePayload(line: Partial<BrLineValues>): {
  ncm: string | null;
  cfop: string | null;
  fiscalData: BrLineFiscalPayload | null;
} {
  const fiscal: BrLineFiscalPayload = {};
  if (line.brCest?.trim()) fiscal.cest = line.brCest.trim();
  if (line.brOrigin) fiscal.origin = line.brOrigin;
  const icms = parseRate(line.brIcmsRate ?? '');
  if (icms !== undefined && !Number.isNaN(icms)) fiscal.icmsRate = icms;
  const ipi = parseRate(line.brIpiRate ?? '');
  if (ipi !== undefined && !Number.isNaN(ipi)) fiscal.ipiRate = ipi;
  const iss = parseRate(line.brIssRate ?? '');
  if (iss !== undefined && !Number.isNaN(iss)) fiscal.issRate = iss;
  if (line.brServiceCode?.trim()) fiscal.serviceCode = line.brServiceCode.trim();
  return {
    ncm: line.ncm?.trim() || null,
    cfop: line.cfop?.trim() || null,
    fiscalData: Object.keys(fiscal).length > 0 ? fiscal : null,
  };
}

/** True when the line carries any fiscal detail beyond NCM and CFOP (its "Fiscal details" start open). */
export function hasBrLineDetails(line: Partial<BrLineValues>): boolean {
  return Boolean(
    line.brOrigin || line.brIcmsRate?.trim() || line.brIpiRate?.trim() || line.brIssRate?.trim() || line.brServiceCode?.trim() || line.brCest?.trim(),
  );
}

// ---------------------------------------------------------------------------
// Document level
// ---------------------------------------------------------------------------

export type BrBuyerIcms = 'auto' | 'yes' | 'no';

/** IRRF rates of the withholding select (professional services, cleaning / security); other rates can be typed. */
export const BR_IRRF_PRESETS = ['1.5', '1'] as const;

/** A document's Brazilian fields, as form state. */
export interface BrDocumentValues {
  /** ISS withheld by the service taker, percent ('' = none). */
  brIssWithheld: string;
  /** IRRF, percent ('' = none). */
  brIrrf: string;
  /** PIS 0.65% + COFINS 3% + CSLL 1% withheld. */
  brCsrf: boolean;
  /** INSS on labour supply, percent ('' = none). */
  brInss: string;
  /** The buyer is the final consumer (consumo final). */
  brFinalConsumer: boolean;
  /** Buyer registered for ICMS: 'auto' leaves it to the tax id. */
  brBuyerIcms: BrBuyerIcms;
  /** Bills: the supplier's NF-e access key (44 digits). */
  brAccessKey: string;
}

export const EMPTY_BR_DOCUMENT: BrDocumentValues = {
  brIssWithheld: '',
  brIrrf: '',
  brCsrf: false,
  brInss: '',
  brFinalConsumer: false,
  brBuyerIcms: 'auto',
  brAccessKey: '',
};

export const brDocumentFields = {
  brIssWithheld: z.string().default(''),
  brIrrf: z.string().default(''),
  brCsrf: z.boolean().default(false),
  brInss: z.string().default(''),
  brFinalConsumer: z.boolean().default(false),
  brBuyerIcms: z.enum(['auto', 'yes', 'no']).default('auto'),
  brAccessKey: z.string().default(''),
};

export interface BrDocumentMessages {
  /** ISS withholding between 0 and 5. */
  iss: string;
  /** IRRF between 0 and 27.5. */
  irrf: string;
  /** INSS between 0 and 20. */
  inss: string;
  accessKey: string;
}

export function brDocumentProblems(
  doc: Partial<BrDocumentValues>,
  messages: BrDocumentMessages,
): Partial<Record<keyof BrDocumentValues, string>> {
  const problems: Partial<Record<keyof BrDocumentValues, string>> = {};
  const check = (key: 'brIssWithheld' | 'brIrrf' | 'brInss', max: number, message: string) => {
    const n = parseRate(doc[key] ?? '');
    if (n !== undefined && (Number.isNaN(n) || n < 0 || n > max)) problems[key] = message;
  };
  check('brIssWithheld', 5, messages.iss);
  check('brIrrf', 27.5, messages.irrf);
  check('brInss', 20, messages.inss);
  if (doc.brAccessKey?.trim() && !/^\d{44}$/.test(doc.brAccessKey.replace(/\s/g, ''))) problems.brAccessKey = messages.accessKey;
  return problems;
}

export function brDocumentChecks(messages: BrDocumentMessages) {
  return (doc: Partial<BrDocumentValues>, ctx: z.RefinementCtx) => {
    for (const [field, message] of Object.entries(brDocumentProblems(doc, messages))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  };
}

/** A stored buyer-ICMS flag as the three-way choice of the form. */
function buyerIcmsChoice(value: unknown): BrBuyerIcms {
  if (value === undefined) return 'auto';
  return value ? 'yes' : 'no';
}

/** The document fiscal data of a stored document, as form state. */
export function brDocumentValuesFromStored(fiscalData: Record<string, unknown> | null | undefined): BrDocumentValues {
  if (!fiscalData) return EMPTY_BR_DOCUMENT;
  const w = (fiscalData.withholdings ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  return {
    brIssWithheld: num(w.iss),
    brIrrf: num(w.irrf),
    brCsrf: w.csrf === true,
    brInss: num(w.inss),
    brFinalConsumer: fiscalData.finalConsumer === true,
    brBuyerIcms: buyerIcmsChoice(fiscalData.buyerIcmsContributor),
    brAccessKey: typeof fiscalData.accessKey === 'string' ? fiscalData.accessKey : '',
  };
}

/** What a create / update body sends as the document's `fiscalData`. */
export type BrDocumentFiscalPayload = {
  withholdings?: { iss?: number; irrf?: number; csrf?: boolean; inss?: number };
  finalConsumer?: boolean;
  buyerIcmsContributor?: boolean;
  accessKey?: string;
};

/** The document `fiscalData`, or `null` (clears a stored one) when nothing is set. */
export function brDocumentPayload(doc: Partial<BrDocumentValues>, options: { bill?: boolean } = {}): BrDocumentFiscalPayload | null {
  const out: BrDocumentFiscalPayload = {};
  const withholdings: NonNullable<BrDocumentFiscalPayload['withholdings']> = {};
  const positive = (value: string | undefined) => {
    const n = parseRate(value ?? '');
    return n !== undefined && !Number.isNaN(n) && n > 0 ? n : undefined;
  };
  const iss = positive(doc.brIssWithheld);
  if (iss !== undefined) withholdings.iss = iss;
  const irrf = positive(doc.brIrrf);
  if (irrf !== undefined) withholdings.irrf = irrf;
  if (doc.brCsrf) withholdings.csrf = true;
  const inss = positive(doc.brInss);
  if (inss !== undefined) withholdings.inss = inss;
  if (Object.keys(withholdings).length > 0) out.withholdings = withholdings;
  if (doc.brFinalConsumer) out.finalConsumer = true;
  if (doc.brBuyerIcms && doc.brBuyerIcms !== 'auto') out.buyerIcmsContributor = doc.brBuyerIcms === 'yes';
  if (options.bill && doc.brAccessKey?.trim()) out.accessKey = doc.brAccessKey.replace(/\s/g, '');
  return Object.keys(out).length > 0 ? out : null;
}

/** True when a document has any withholding set (the section starts open). */
export function hasBrWithholdings(doc: Partial<BrDocumentValues>): boolean {
  return Boolean(doc.brIssWithheld?.trim() || doc.brIrrf?.trim() || doc.brCsrf || doc.brInss?.trim());
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

/** How a tax relates to the price: on top, inside it, kept back by the payer, or printed for information. */
export type BrTaxTreatment = 'added' | 'embedded' | 'withheld' | 'informational';

export const BR_TREATMENT_ORDER: readonly BrTaxTreatment[] = ['added', 'embedded', 'withheld', 'informational'];

/** A stored breakdown row, with the Brazilian `treatment` and `component` the server adds. */
export type BrTaxRow = TaxBreakdownRow;

export interface BrTaxGroup {
  treatment: BrTaxTreatment;
  rows: BrTaxRow[];
  /** Sum of the rows' tax (what is added, withheld, ...). */
  total: number;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** True when the breakdown comes from the Brazilian engine (its rows carry a treatment). */
export function isBrBreakdown(rows: readonly BrTaxRow[] | null | undefined): boolean {
  return Boolean(rows?.some((row) => row.treatment !== undefined));
}

/**
 * The rows of a Brazilian document grouped by treatment: taxes on top of the
 * price, taxes included in it, withholdings, CBS / IBS for information. Rows of
 * the same tax and rate on different lines are summed. Empty groups are left out.
 */
export function groupBrTaxRows(rows: readonly BrTaxRow[] | null | undefined): BrTaxGroup[] {
  const groups = new Map<BrTaxTreatment, Map<string, BrTaxRow>>();
  for (const row of rows ?? []) {
    if (!row.taxAmount && !row.taxableAmount) continue;
    const treatment = row.treatment ?? 'added';
    const bucket = groups.get(treatment) ?? new Map<string, BrTaxRow>();
    const key = `${row.component ?? row.taxRateName}|${row.taxRate}`;
    const existing = bucket.get(key);
    if (existing) {
      existing.taxableAmount = roundCents(existing.taxableAmount + row.taxableAmount);
      existing.taxAmount = roundCents(existing.taxAmount + row.taxAmount);
    } else {
      bucket.set(key, { ...row, treatment });
    }
    groups.set(treatment, bucket);
  }
  return BR_TREATMENT_ORDER.flatMap((treatment) => {
    const bucket = groups.get(treatment);
    if (!bucket) return [];
    const list = [...bucket.values()];
    return [{ treatment, rows: list, total: roundCents(list.reduce((sum, row) => sum + row.taxAmount, 0)) }];
  });
}
