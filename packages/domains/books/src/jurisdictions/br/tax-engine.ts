import type {
  DocumentTaxContext,
  DocumentTaxLineInput,
  DocumentTaxResult,
  DocumentTaxRow,
  SystemAccountRole,
} from '../types';
import { brRegimeOf, brSettingsOf, isSimplesRegime, pisCofinsRates, type BrTaxRegime } from './regimes';
import { brProfileOf, type BrTaxProfile } from './tax-profiles';
import { brState, icmsRateForSale } from './states';

/**
 * Brazilian document tax engine.
 *
 * One line can carry several taxes, each with its own base and its own
 * relation to the price:
 *
 *   ISS, ICMS (+FCP), PIS, COFINS   inside the price ("por dentro"): `embedded`
 *   IPI                             on top of the price ("por fora"): `added`
 *   CBS / IBS in 2026               printed only, test year:           `informational`
 *   IRRF, CSRF, INSS, ISS retido    kept back by the payer:            `withheld`
 *
 * Bases:
 *   ISS       the service amount
 *   IPI       the line amount
 *   ICMS      the line amount, plus IPI when the buyer is a final consumer
 *             (art. 155 §2 XI CF)
 *   PIS/COF   the line amount less the ICMS (STF Tema 69)
 *   CBS/IBS   the line amount less ICMS, ISS, PIS and COFINS (LC 214/2025 art. 12 §2)
 *
 * Simples Nacional and MEI itemise nothing: their taxes are paid in the DAS,
 * worked out on monthly revenue (simples.ts). Withholdings still apply.
 *
 * Sales rows carry the payable (`accountRole`) and, when embedded, the revenue
 * deduction (`offsetAccountRole`); purchase rows carry the recoverable account
 * of a credit, or the payable of a withholding.
 */

export interface BrLineFiscalData {
  ncm?: string;
  cfop?: string;
  cest?: string;
  /** NF-e origin of the goods (0-8). */
  origin?: string;
  icmsRate?: number;
  ipiRate?: number;
  issRate?: number;
  /** LC 116/2003 service item, e.g. "01.07". */
  serviceCode?: string;
}

export interface BrWithholdingConfig {
  /** ISS withheld by the service taker, percent. */
  iss?: number | null;
  /** IRRF, percent: 1.5 for professional services, 1 for cleaning, security and the like. */
  irrf?: number | null;
  /** PIS 0.65% + COFINS 3% + CSLL 1% (Lei 10.833/2003 art. 30). */
  csrf?: boolean | null;
  /** INSS on labour supply (cessão de mão de obra), percent: 11, or 3.5 under CPRB. */
  inss?: number | null;
}

export interface BrDocumentFiscalData {
  withholdings?: BrWithholdingConfig;
  /** Buyer is the final consumer (consumo final). Defaults to "not an ICMS taxpayer". */
  finalConsumer?: boolean;
  /** Buyer is registered for ICMS (indIEDest 1). Defaults to true when its tax id is a CNPJ. */
  buyerIcmsContributor?: boolean;
  /** The other party is in the Simples Nacional (no IRRF/CSRF withholding on its services). */
  counterpartySimples?: boolean;
  naturezaOperacao?: string;
}

/** Withholding amounts at or under this are not withheld (Lei 9.430/96 art. 67, Lei 10.833/03 art. 31 §3). */
export const BR_WITHHOLDING_MINIMUM = 10;

/** CBS / IBS test rates of 2026 (LC 214/2025 art. 343, 346). */
export const BR_CBS_TEST_RATE = 0.9;
export const BR_IBS_TEST_RATE = 0.1;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function pct(rate: number): string {
  return `${rate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function yearOf(date: string | undefined): number {
  const year = Number.parseInt((date ?? '').slice(0, 4), 10);
  return Number.isFinite(year) && year > 2000 ? year : new Date().getUTCFullYear();
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

interface RowArgs {
  line: DocumentTaxLineInput;
  name: string;
  component: string;
  rate: number;
  base: number;
  treatment: NonNullable<DocumentTaxRow['treatment']>;
  accountRole?: SystemAccountRole;
  offsetAccountRole?: SystemAccountRole;
}

function row(args: RowArgs): DocumentTaxRow {
  return {
    taxRateId: args.line.taxRateId ?? '',
    taxRateName: `${args.name} ${pct(args.rate)}`,
    taxRate: args.rate,
    taxableAmount: round2(args.base),
    taxAmount: round2(args.base * (args.rate / 100)),
    component: args.component,
    accountRole: args.accountRole,
    offsetAccountRole: args.offsetAccountRole,
    taxCategoryCode: args.line.taxCategoryCode ?? 'standard',
    treatment: args.treatment,
  };
}

interface EngineState {
  regime: BrTaxRegime;
  year: number;
  direction: 'sales' | 'purchase';
  entityUf?: string;
  counterpartyUf?: string;
  foreign: boolean;
  finalConsumer: boolean;
  cbsRate?: number;
  ibsRate?: number;
  defaultIssRate: number;
  icmsContributor: boolean;
  warnings: Set<string>;
}

function salesLine(line: DocumentTaxLineInput, profile: BrTaxProfile, s: EngineState): DocumentTaxRow[] {
  if (profile.kind === 'exempt' || profile.kind === 'export_goods' || profile.kind === 'export_service') return [];
  if (s.foreign) return [];
  if (isSimplesRegime(s.regime)) return [];

  const fiscal = (line.fiscalData ?? {}) as BrLineFiscalData;
  const amount = line.lineTotal;
  const rows: DocumentTaxRow[] = [];
  let icmsTotal = 0;
  let issAmount = 0;

  if (profile.kind === 'service') {
    const iss = salesIssRow(line, profile, fiscal, s);
    issAmount = iss.taxAmount;
    rows.push(iss);
  } else {
    // Goods: IPI on top (production), ICMS inside.
    let ipiAmount = 0;
    if (profile.kind === 'goods_production') {
      const ipi = productionIpiRow(line, fiscal, s);
      if (ipi) {
        ipiAmount = ipi.taxAmount;
        rows.push(ipi);
      }
    }
    const icms = salesIcmsRows(line, fiscal, s, ipiAmount);
    icmsTotal = icms.total;
    rows.push(...icms.rows);
  }

  // PIS / COFINS until 2026; from 2027 they are replaced by CBS.
  const pisCofins = salesPisCofinsRows(line, amount - icmsTotal, s);
  rows.push(...pisCofins.rows);

  rows.push(...cbsIbsRows(line, amount - icmsTotal - issAmount - pisCofins.total, s));
  return rows;
}

function salesIssRow(line: DocumentTaxLineInput, profile: BrTaxProfile, fiscal: BrLineFiscalData, s: EngineState): DocumentTaxRow {
  const issRate = num(fiscal.issRate) ?? profile.issRate ?? s.defaultIssRate;
  return row({
    line,
    name: 'ISS',
    component: 'iss',
    rate: issRate,
    base: line.lineTotal,
    treatment: 'embedded',
    accountRole: 'tax_payable_iss',
    offsetAccountRole: 'revenue_deduction_iss',
  });
}

/** IPI on top of the price of goods of own production, or null when the line has no IPI rate. */
function productionIpiRow(line: DocumentTaxLineInput, fiscal: BrLineFiscalData, s: EngineState): DocumentTaxRow | null {
  const ipiRate = num(fiscal.ipiRate) ?? 0;
  if (s.year >= 2027 && ipiRate > 0) {
    s.warnings.add('IPI is reduced to zero from 2027 (LC 214/2025) except for goods also made in the Zona Franca de Manaus: check the rate.');
  }
  if (ipiRate > 0) {
    return row({ line, name: 'IPI', component: 'ipi', rate: ipiRate, base: line.lineTotal, treatment: 'added', accountRole: 'tax_payable_ipi' });
  }
  if (!fiscal.ipiRate && fiscal.ipiRate !== 0) {
    s.warnings.add('No IPI rate on a line of own production: enter the TIPI rate of its NCM (0 if none).');
  }
  return null;
}

/** ICMS (and FCP) inside the price of goods sold; the base includes the IPI when the buyer is a final consumer. */
function salesIcmsRows(
  line: DocumentTaxLineInput,
  fiscal: BrLineFiscalData,
  s: EngineState,
  ipiAmount: number,
): { rows: DocumentTaxRow[]; total: number } {
  const rows: DocumentTaxRow[] = [];
  let total = 0;
  if (!s.entityUf) s.warnings.add("The entity's state (UF) is not set, so ICMS can't be worked out.");
  const resolved = s.entityUf
    ? icmsRateForSale({ originUf: s.entityUf, destinationUf: s.counterpartyUf ?? s.entityUf, origin: fiscal.origin })
    : { rate: 0, interstate: false, fcp: 0 };
  const icmsRate = num(fiscal.icmsRate) ?? resolved.rate;
  const icmsBase = line.lineTotal + (s.finalConsumer ? ipiAmount : 0);
  if (icmsRate > 0) {
    const icms = row({
      line,
      name: 'ICMS',
      component: 'icms',
      rate: icmsRate,
      base: icmsBase,
      treatment: 'embedded',
      accountRole: 'tax_payable_icms',
      offsetAccountRole: 'revenue_deduction_icms',
    });
    total += icms.taxAmount;
    rows.push(icms);
  }
  if (resolved.fcp > 0 && fiscal.icmsRate === undefined) {
    const fcp = row({
      line,
      name: 'FCP',
      component: 'fcp',
      rate: resolved.fcp,
      base: icmsBase,
      treatment: 'embedded',
      accountRole: 'tax_payable_icms',
      offsetAccountRole: 'revenue_deduction_icms',
    });
    total += fcp.taxAmount;
    rows.push(fcp);
  }
  if (resolved.interstate && s.finalConsumer) {
    s.warnings.add(
      'Interstate sale to a final consumer: the ICMS rate difference (DIFAL) owed to the destination state is not calculated. Add it on the NF-e or pay it by GNRE.',
    );
  }
  return { rows, total };
}

/** PIS and COFINS inside the price, on the line amount less the ICMS; none from 2027. */
function salesPisCofinsRows(line: DocumentTaxLineInput, base: number, s: EngineState): { rows: DocumentTaxRow[]; total: number } {
  const pisCofins = pisCofinsRates(s.regime);
  if (!pisCofins || s.year >= 2027) return { rows: [], total: 0 };
  const pis = row({
    line,
    name: 'PIS',
    component: 'pis',
    rate: pisCofins.pis,
    base,
    treatment: 'embedded',
    accountRole: 'tax_payable_pis',
    offsetAccountRole: 'revenue_deduction_pis',
  });
  const cofins = row({
    line,
    name: 'COFINS',
    component: 'cofins',
    rate: pisCofins.cofins,
    base,
    treatment: 'embedded',
    accountRole: 'tax_payable_cofins',
    offsetAccountRole: 'revenue_deduction_cofins',
  });
  return { rows: [pis, cofins], total: pis.taxAmount + cofins.taxAmount };
}

/**
 * CBS and IBS. 2026 is a test year: 0.9% CBS and 0.1% IBS are printed on the
 * fiscal document and offset against PIS/COFINS, so nothing is booked. From
 * 2027 CBS is a real tax on top of the price at the rate set in the entity's
 * settings (the reference rate is fixed by the Senate each year).
 */
function cbsIbsRows(line: DocumentTaxLineInput, base: number, s: EngineState): DocumentTaxRow[] {
  if (isSimplesRegime(s.regime) || base <= 0) return [];
  if (s.year === 2026) {
    return [
      row({ line, name: 'CBS', component: 'cbs', rate: BR_CBS_TEST_RATE, base, treatment: 'informational' }),
      row({ line, name: 'IBS', component: 'ibs', rate: BR_IBS_TEST_RATE, base, treatment: 'informational' }),
    ];
  }
  if (s.year < 2026) return [];
  const rows: DocumentTaxRow[] = [];
  const sales = s.direction === 'sales';
  if (s.cbsRate && s.cbsRate > 0) {
    rows.push(
      row({
        line,
        name: 'CBS',
        component: 'cbs',
        rate: s.cbsRate,
        base,
        treatment: 'added',
        accountRole: sales ? 'tax_payable_cbs' : 'tax_recoverable_cbs',
      }),
    );
  } else {
    s.warnings.add(`No CBS rate is set for ${s.year}: add it under the entity's Brazil settings.`);
  }
  if (s.ibsRate && s.ibsRate > 0) {
    rows.push(
      row({
        line,
        name: 'IBS',
        component: 'ibs',
        rate: s.ibsRate,
        base,
        treatment: 'added',
        accountRole: sales ? 'tax_payable_ibs' : 'tax_recoverable_ibs',
      }),
    );
  }
  return rows;
}

function purchaseLine(line: DocumentTaxLineInput, profile: BrTaxProfile, s: EngineState): DocumentTaxRow[] {
  const credits = profile.credits;
  if (!credits || isSimplesRegime(s.regime) || s.foreign) return [];
  const fiscal = (line.fiscalData ?? {}) as BrLineFiscalData;
  const amount = line.lineTotal;
  const rows: DocumentTaxRow[] = [];

  const ipiRate = num(fiscal.ipiRate) ?? 0;
  if (ipiRate > 0) {
    // IPI the supplier added on top: a credit for an industrial establishment, otherwise part of the cost.
    rows.push(row({
      line,
      name: 'IPI',
      component: 'ipi',
      rate: ipiRate,
      base: amount,
      treatment: 'added',
      accountRole: credits.ipi ? 'tax_recoverable_ipi' : undefined,
    }));
  }

  let icmsAmount = 0;
  if (credits.icms && s.icmsContributor) {
    const resolved = s.entityUf
      ? icmsRateForSale({ originUf: s.counterpartyUf ?? s.entityUf, destinationUf: s.entityUf, origin: fiscal.origin })
      : { rate: 0, interstate: false, fcp: 0 };
    const icmsRate = num(fiscal.icmsRate) ?? resolved.rate;
    if (icmsRate > 0) {
      const icms = row({
        line,
        name: 'ICMS',
        component: 'icms',
        rate: icmsRate,
        // Goods bought for resale or production: IPI stays out of the ICMS base (art. 155 §2 XI CF).
        base: amount,
        treatment: 'embedded',
        accountRole: 'tax_recoverable_icms',
      });
      icmsAmount = icms.taxAmount;
      rows.push(icms);
    }
  }

  if (credits.pisCofins && s.regime === 'lucro_real' && s.year < 2027) {
    const base = amount - icmsAmount;
    rows.push(
      row({ line, name: 'PIS', component: 'pis', rate: 1.65, base, treatment: 'embedded', accountRole: 'tax_recoverable_pis' }),
      row({ line, name: 'COFINS', component: 'cofins', rate: 7.6, base, treatment: 'embedded', accountRole: 'tax_recoverable_cofins' }),
    );
  }
  return rows;
}

/**
 * Withholdings on the service lines of the document. On a sale they are what
 * the customer keeps back (a receivable we offset against our own taxes, or,
 * for ISS, the ISS we no longer pay ourselves); on a purchase what we keep back
 * from the supplier and must pay over (a payable).
 */
function withholdingRows(
  serviceBase: number,
  config: BrWithholdingConfig,
  s: EngineState,
  counterpartySimples: boolean,
): DocumentTaxRow[] {
  if (serviceBase <= 0) return [];
  const sales = s.direction === 'sales';
  const w: WithholdingContext = {
    doc: {
      lineTotal: serviceBase,
      taxRateId: null,
      taxRateName: null,
      taxCategoryCode: 'standard',
      rate: 0,
      jurisdictionMetadata: null,
    },
    serviceBase,
    sales,
    // The provider of the service: us on a sale, the supplier on a purchase.
    providerSimples: sales ? isSimplesRegime(s.regime) : counterpartySimples,
    s,
  };
  return [
    ...issWithholdingRows(w, num(config.iss)),
    ...irrfWithholdingRows(w, num(config.irrf)),
    ...csrfWithholdingRows(w, config.csrf),
    ...inssWithholdingRows(w, num(config.inss)),
  ];
}

interface WithholdingContext {
  doc: DocumentTaxLineInput;
  serviceBase: number;
  sales: boolean;
  providerSimples: boolean;
  s: EngineState;
}

function issWithholdingRows(w: WithholdingContext, issRate: number | undefined): DocumentTaxRow[] {
  if (!issRate || issRate <= 0) return [];
  let issRole: SystemAccountRole = 'withholding_payable_iss';
  if (w.sales) issRole = w.providerSimples ? 'revenue_deduction_iss' : 'tax_payable_iss';
  return [row({ line: w.doc, name: 'ISS retido', component: 'iss_ret', rate: issRate, base: w.serviceBase, treatment: 'withheld', accountRole: issRole })];
}

function irrfWithholdingRows(w: WithholdingContext, irrfRate: number | undefined): DocumentTaxRow[] {
  if (!irrfRate || irrfRate <= 0) return [];
  if (w.providerSimples) {
    w.s.warnings.add('No IRRF is withheld from a Simples Nacional provider.');
    return [];
  }
  const irrf = row({
    line: w.doc,
    name: 'IRRF',
    component: 'irrf',
    rate: irrfRate,
    base: w.serviceBase,
    treatment: 'withheld',
    accountRole: w.sales ? 'withheld_receivable_irrf' : 'withholding_payable_irrf',
  });
  if (irrf.taxAmount <= BR_WITHHOLDING_MINIMUM) {
    w.s.warnings.add(`IRRF of R$ ${irrf.taxAmount.toFixed(2)} is not withheld (R$ 10.00 or less).`);
    return [];
  }
  return [irrf];
}

function csrfWithholdingRows(w: WithholdingContext, csrfEnabled: boolean | null | undefined): DocumentTaxRow[] {
  if (!csrfEnabled) return [];
  if (w.providerSimples) {
    w.s.warnings.add('No PIS/COFINS/CSLL is withheld from a Simples Nacional provider.');
    return [];
  }
  const { doc, serviceBase, sales } = w;
  const csrf = [
    row({ line: doc, name: 'PIS retido', component: 'pis_ret', rate: 0.65, base: serviceBase, treatment: 'withheld', accountRole: sales ? 'withheld_receivable_pis' : 'withholding_payable_csrf' }),
    row({ line: doc, name: 'COFINS retida', component: 'cofins_ret', rate: 3, base: serviceBase, treatment: 'withheld', accountRole: sales ? 'withheld_receivable_cofins' : 'withholding_payable_csrf' }),
    row({ line: doc, name: 'CSLL retida', component: 'csll_ret', rate: 1, base: serviceBase, treatment: 'withheld', accountRole: sales ? 'withheld_receivable_csll' : 'withholding_payable_csrf' }),
  ];
  const total = round2(csrf.reduce((sum, r) => sum + r.taxAmount, 0));
  if (total <= BR_WITHHOLDING_MINIMUM) {
    w.s.warnings.add(`PIS/COFINS/CSLL of R$ ${total.toFixed(2)} is not withheld (R$ 10.00 or less).`);
    return [];
  }
  return csrf;
}

function inssWithholdingRows(w: WithholdingContext, inssRate: number | undefined): DocumentTaxRow[] {
  if (!inssRate || inssRate <= 0) return [];
  return [
    row({
      line: w.doc,
      name: 'INSS retido',
      component: 'inss_ret',
      rate: inssRate,
      base: w.serviceBase,
      treatment: 'withheld',
      accountRole: w.sales ? 'withheld_receivable_inss' : 'withholding_payable_inss',
    }),
  ];
}

function counterpartyIsForeign(country: string | null | undefined): boolean {
  if (!country) return false;
  const c = country.trim().toUpperCase();
  return c !== '' && c !== 'BR' && c !== 'BRA' && c !== 'BRAZIL' && c !== 'BRASIL';
}

export function computeBrDocumentTaxes(lines: DocumentTaxLineInput[], ctx: DocumentTaxContext): DocumentTaxResult {
  const settings = brSettingsOf(ctx.entitySettings);
  const fiscal = (ctx.documentFiscal ?? {}) as BrDocumentFiscalData;
  const counterpartyTaxId = (ctx.counterparty?.taxId ?? '').replace(/\D/g, '');
  const counterpartyFiscal = (ctx.counterparty?.fiscal ?? {}) as { icmsContributor?: boolean; simplesNacional?: boolean };
  const buyerIsCompany = counterpartyTaxId.length === 14;
  const buyerIcmsContributor = fiscal.buyerIcmsContributor ?? counterpartyFiscal.icmsContributor ?? buyerIsCompany;

  const s: EngineState = {
    regime: brRegimeOf(ctx.entityTaxClassification),
    year: yearOf(ctx.issueDate),
    direction: ctx.direction,
    entityUf: brState(settings.uf)?.uf,
    counterpartyUf: brState(ctx.counterparty?.stateCode)?.uf,
    foreign: counterpartyIsForeign(ctx.counterparty?.country),
    finalConsumer: fiscal.finalConsumer ?? !buyerIcmsContributor,
    cbsRate: num(settings.cbsRate),
    ibsRate: num(settings.ibsRate),
    defaultIssRate: num(settings.issRate) ?? 5,
    icmsContributor: settings.icmsContributor ?? true,
    warnings: new Set(),
  };

  let serviceBase = 0;
  const resultLines = lines.map((line) => {
    const profile = brProfileOf(line.jurisdictionMetadata);
    if (!profile) {
      // A rate without a Brazilian profile (created by hand): a plain rate on top of the price.
      if (!line.rate) return { rows: [] };
      return {
        rows: [
          {
            taxRateId: line.taxRateId ?? '',
            taxRateName: line.taxRateName ?? pct(line.rate),
            taxRate: line.rate,
            taxableAmount: round2(line.lineTotal),
            taxAmount: round2(line.lineTotal * (line.rate / 100)),
            taxCategoryCode: line.taxCategoryCode ?? 'standard',
          },
        ],
      };
    }
    if (profile.kind === 'service' || profile.kind === 'export_service') serviceBase += line.lineTotal;
    return { rows: ctx.direction === 'sales' ? salesLine(line, profile, s) : purchaseLine(line, profile, s) };
  });

  const documentRows = fiscal.withholdings
    ? withholdingRows(round2(serviceBase), fiscal.withholdings, s, fiscal.counterpartySimples ?? counterpartyFiscal.simplesNacional ?? false)
    : [];

  return { lines: resultLines, documentRows, warnings: [...s.warnings] };
}

/**
 * Suggested withholdings for a service sold to (or bought from) a company,
 * following the federal rules; ISS depends on the municipality and INSS on
 * whether the service is a supply of labour, so those stay the user's call.
 */
export function suggestBrWithholdings(args: {
  providerRegime: BrTaxRegime;
  takerIsCompany: boolean;
  serviceKind?: 'professional' | 'cleaning_security' | 'other';
}): BrWithholdingConfig {
  if (!args.takerIsCompany || isSimplesRegime(args.providerRegime)) return {};
  const config: BrWithholdingConfig = { csrf: true };
  if (args.serviceKind === 'professional') config.irrf = 1.5;
  else if (args.serviceKind === 'cleaning_security') config.irrf = 1;
  return config;
}
