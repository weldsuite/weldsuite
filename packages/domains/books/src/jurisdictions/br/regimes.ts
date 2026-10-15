/**
 * Brazilian tax regimes (regime tributário), stored on entities.tax_classification.
 *
 * - mei: Microempreendedor Individual, a fixed monthly DAS-MEI.
 * - simples_nacional: ME/EPP in the Simples Nacional, one monthly DAS on revenue
 *   (LC 123/2006). No tax is itemised on its invoices.
 * - lucro_presumido: IRPJ/CSLL on a presumed margin, cumulative PIS/COFINS.
 * - lucro_real: IRPJ/CSLL on the accounting profit, non-cumulative PIS/COFINS.
 */
export const BR_TAX_REGIMES = ['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real'] as const;
export type BrTaxRegime = (typeof BR_TAX_REGIMES)[number];

export const DEFAULT_BR_REGIME: BrTaxRegime = 'simples_nacional';

export function isBrTaxRegime(value: unknown): value is BrTaxRegime {
  return typeof value === 'string' && (BR_TAX_REGIMES as readonly string[]).includes(value);
}

export function brRegimeOf(taxClassification: string | null | undefined): BrTaxRegime {
  return isBrTaxRegime(taxClassification) ? taxClassification : DEFAULT_BR_REGIME;
}

/**
 * Legal forms (natureza jurídica, simplified): MEI, empresário individual,
 * sociedade limitada unipessoal, sociedade limitada, sociedade anônima.
 * (The EIRELI no longer exists: Lei 14.195/2021 turned them into SLUs.)
 */
export const BR_ENTITY_TYPES = ['mei', 'ei', 'slu', 'ltda', 'sa'] as const;
export type BrEntityType = (typeof BR_ENTITY_TYPES)[number];

export function isBrEntityType(value: unknown): value is BrEntityType {
  return typeof value === 'string' && (BR_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Which regimes a legal form can be in: only a MEI is in the SIMEI, and an S.A. can't opt for the Simples (LC 123 art. 3 §4 X). */
export function allowedBrRegimes(entityType: BrEntityType | null | undefined): BrTaxRegime[] {
  if (entityType === 'mei') return ['mei'];
  if (entityType === 'sa') return ['lucro_presumido', 'lucro_real'];
  return ['simples_nacional', 'lucro_presumido', 'lucro_real'];
}

/** Time zone of a state (Brazil has four, and no daylight saving time since 2019). */
const UF_TIMEZONES: Record<string, string> = {
  AC: 'America/Rio_Branco',
  AM: 'America/Manaus',
  RR: 'America/Boa_Vista',
  RO: 'America/Porto_Velho',
  MT: 'America/Cuiaba',
  MS: 'America/Campo_Grande',
  PA: 'America/Belem',
  AP: 'America/Belem',
  TO: 'America/Araguaina',
  MA: 'America/Fortaleza',
  PI: 'America/Fortaleza',
  CE: 'America/Fortaleza',
  RN: 'America/Fortaleza',
  PB: 'America/Fortaleza',
  PE: 'America/Recife',
  AL: 'America/Maceio',
  SE: 'America/Maceio',
  BA: 'America/Bahia',
};

export function timezoneOfUf(uf: string | null | undefined): string {
  return (uf && UF_TIMEZONES[uf.toUpperCase()]) || 'America/Sao_Paulo';
}

/** The regimes that pay their taxes through a single DAS instead of itemising them. */
export function isSimplesRegime(regime: BrTaxRegime): boolean {
  return regime === 'simples_nacional' || regime === 'mei';
}

/**
 * Código de Regime Tributário printed on NF-e (CRT): 1 Simples Nacional,
 * 2 Simples over the ICMS/ISS sublimit, 3 regime normal, 4 MEI.
 */
export function crtOf(regime: BrTaxRegime, overSublimit = false): '1' | '2' | '3' | '4' {
  if (regime === 'mei') return '4';
  if (regime === 'simples_nacional') return overSublimit ? '2' : '1';
  return '3';
}

/** PIS and COFINS rates (percent) for a regime: cumulative under Presumido, non-cumulative under Real. */
export function pisCofinsRates(regime: BrTaxRegime): { pis: number; cofins: number; cumulative: boolean } | null {
  if (regime === 'lucro_presumido') return { pis: 0.65, cofins: 3, cumulative: true };
  if (regime === 'lucro_real') return { pis: 1.65, cofins: 7.6, cumulative: false };
  return null;
}

/**
 * The entity's Brazilian settings, kept in entities.jurisdiction_settings.
 * Everything is optional: the engine warns about what is missing.
 */
export interface BrEntitySettings {
  /** State of the establishment (UF). */
  uf?: string;
  /** IBGE municipality code (7 digits) and name. */
  municipalityCode?: string;
  municipalityName?: string;
  /** Inscrição municipal (service providers). */
  inscricaoMunicipal?: string;
  /** Main CNAE activity code. */
  cnae?: string;
  /** Default ISS rate of the municipality for the entity's main service, percent (2-5). */
  issRate?: number;
  /** Default Simples Nacional annex for revenue without a profile. */
  simplesAnexo?: 'I' | 'II' | 'III' | 'IV' | 'V';
  /** Registered for ICMS (has an Inscrição Estadual). Defaults to true for goods sellers. */
  icmsContributor?: boolean;
  /** CBS / IBS rates from 2027 on, percent, once the reference rates are published. */
  cbsRate?: number;
  ibsRate?: number;
  /** Pix key printed on invoices as a BR Code, with the city it is registered in. */
  pixKey?: string;
  pixCity?: string;
  /** Fiscal document provider (Focus NFe) and its environment. */
  fiscalProvider?: 'focus_nfe';
  fiscalEnvironment?: 'homologacao' | 'producao';
  /** Series used for NF-e (goods) documents. */
  nfeSeries?: string;
  /** Payroll of the last 12 months, for the Simples Nacional fator R, when WeldHR payroll is not used. */
  payroll12m?: number;
}

export function brSettingsOf(settings: Record<string, unknown> | null | undefined): BrEntitySettings {
  return (settings ?? {}) as BrEntitySettings;
}
