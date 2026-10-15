/**
 * Brazilian entity setup as the platform holds it: tax regime, legal form and
 * the `jurisdictionSettings` keys, with the checks the forms run before the
 * server does and the payload they become.
 *
 * Mirrors `regimes.ts` in `@weldsuite/books-domain/jurisdictions/br` (the
 * platform doesn't import the domain package); `br-entity.test.ts` fails when
 * the two drift apart.
 */
import { findBrState } from '@/components/address/br-states';
import {
  brTaxIdProblem,
  cnpjProblem,
  formatCnpj,
  isValidInscricaoEstadual,
  isValidMunicipalityCode,
  normalizeCnpj,
} from './identifiers';
import { isPlausiblePixKey } from './pix';

export const BR_TAX_REGIMES = ['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real'] as const;
export type BrTaxRegime = (typeof BR_TAX_REGIMES)[number];

export const BR_ENTITY_TYPES = ['mei', 'ei', 'slu', 'ltda', 'sa'] as const;
export type BrEntityType = (typeof BR_ENTITY_TYPES)[number];

export const BR_SIMPLES_ANEXOS = ['I', 'II', 'III', 'IV', 'V'] as const;
export type BrSimplesAnexo = (typeof BR_SIMPLES_ANEXOS)[number];

export function isBrEntityType(value: unknown): value is BrEntityType {
  return typeof value === 'string' && (BR_ENTITY_TYPES as readonly string[]).includes(value);
}

export function isBrTaxRegime(value: unknown): value is BrTaxRegime {
  return typeof value === 'string' && (BR_TAX_REGIMES as readonly string[]).includes(value);
}

/** Which regimes a legal form can be in: only a MEI is in the SIMEI, and an S.A. can't opt for the Simples. */
export function allowedBrRegimes(entityType: string | null | undefined): BrTaxRegime[] {
  if (entityType === 'mei') return ['mei'];
  if (entityType === 'sa') return ['lucro_presumido', 'lucro_real'];
  return ['simples_nacional', 'lucro_presumido', 'lucro_real'];
}

/** The regime a new entity of a legal form starts in. */
export function defaultBrRegime(entityType: string | null | undefined): BrTaxRegime {
  return allowedBrRegimes(entityType)[0];
}

/** Keeps a regime when the legal form allows it, else the form's default. */
export function validBrRegime(entityType: string | null | undefined, regime: string | null | undefined): BrTaxRegime {
  const allowed = allowedBrRegimes(entityType);
  return isBrTaxRegime(regime) && allowed.includes(regime) ? regime : allowed[0];
}

/** The regimes whose taxes are paid in one DAS and not itemised on invoices. */
export function isSimplesBrRegime(regime: string | null | undefined): boolean {
  return regime === 'simples_nacional' || regime === 'mei';
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

/** Defaults of a new Brazilian entity (`GET /jurisdictions` says the same: BRL, pt-BR). */
export const BR_DEFAULTS = { baseCurrency: 'BRL', locale: 'pt-BR', timezone: 'America/Sao_Paulo', country: 'BR' } as const;

/** The Brazilian keys of `entities.jurisdiction_settings`, as the form holds them (strings and booleans). */
export interface BrEntityValues {
  /** The tax regime, stored on `taxClassification`. */
  regime: BrTaxRegime;
  uf: string;
  municipalityCode: string;
  municipalityName: string;
  inscricaoMunicipal: string;
  cnae: string;
  issRate: string;
  simplesAnexo: '' | BrSimplesAnexo;
  icmsContributor: boolean;
  nfseStandard: 'nacional' | 'municipal';
  nfeSeries: string;
  pixKey: string;
  pixCity: string;
  cbsRate: string;
  ibsRate: string;
  payroll12m: string;
}

export const DEFAULT_BR_VALUES: BrEntityValues = {
  regime: 'simples_nacional',
  uf: '',
  municipalityCode: '',
  municipalityName: '',
  inscricaoMunicipal: '',
  cnae: '',
  issRate: '',
  simplesAnexo: '',
  icmsContributor: false,
  nfseStandard: 'nacional',
  nfeSeries: '',
  pixKey: '',
  pixCity: '',
  cbsRate: '',
  ibsRate: '',
  payroll12m: '',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** The form values of a stored entity (`taxClassification` + `jurisdictionSettings`). */
export function brValuesFromEntity(entity: {
  entityType?: string | null;
  taxClassification?: string | null;
  jurisdictionSettings?: Record<string, unknown> | null;
}): BrEntityValues {
  const s = entity.jurisdictionSettings ?? {};
  const anexo = text(s.simplesAnexo);
  return {
    regime: validBrRegime(entity.entityType, entity.taxClassification),
    uf: text(s.uf),
    municipalityCode: text(s.municipalityCode),
    municipalityName: text(s.municipalityName),
    inscricaoMunicipal: text(s.inscricaoMunicipal),
    cnae: text(s.cnae),
    issRate: numberText(s.issRate),
    simplesAnexo: (BR_SIMPLES_ANEXOS as readonly string[]).includes(anexo) ? (anexo as BrSimplesAnexo) : '',
    icmsContributor: s.icmsContributor === true,
    nfseStandard: s.nfseStandard === 'municipal' ? 'municipal' : 'nacional',
    nfeSeries: text(s.nfeSeries),
    pixKey: text(s.pixKey),
    pixCity: text(s.pixCity),
    cbsRate: numberText(s.cbsRate),
    ibsRate: numberText(s.ibsRate),
    payroll12m: numberText(s.payroll12m),
  };
}

function parseNumber(value: string): number | undefined {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The `jurisdictionSettings` an entity create / update sends. An update merges
 * them into the stored settings (other keys, such as the fiscal provider state,
 * stay); an emptied field is sent as null, which clears it.
 */
export function brSettingsPayload(values: BrEntityValues): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    icmsContributor: values.icmsContributor,
    nfseStandard: values.nfseStandard,
  };
  const set = (key: string, value: string | number | undefined) => {
    settings[key] = value !== undefined && value !== '' ? value : null;
  };
  set('uf', values.uf.trim().toUpperCase());
  set('municipalityCode', values.municipalityCode.trim());
  set('municipalityName', values.municipalityName.trim());
  set('inscricaoMunicipal', values.inscricaoMunicipal.trim());
  set('cnae', values.cnae.trim());
  set('issRate', parseNumber(values.issRate));
  set('simplesAnexo', values.simplesAnexo);
  set('nfeSeries', values.nfeSeries.trim());
  set('pixKey', values.pixKey.trim());
  set('pixCity', values.pixCity.trim());
  set('cbsRate', parseNumber(values.cbsRate));
  set('ibsRate', parseNumber(values.ibsRate));
  set('payroll12m', parseNumber(values.payroll12m));
  return settings;
}

/** Everything a create / update of a Brazilian entity sends besides the common fields. */
export function brEntityPayload(
  values: BrEntityValues,
  ids: { cnpj?: string; ie?: string },
): { taxClassification: BrTaxRegime; jurisdictionSettings: Record<string, unknown>; taxIdentifiers?: { vatNumber?: string; registrationNumber?: string } } {
  const taxIdentifiers: { vatNumber?: string; registrationNumber?: string } = {};
  const cnpj = ids.cnpj?.trim();
  if (cnpj) taxIdentifiers.vatNumber = formatCnpj(cnpj);
  const ie = ids.ie?.trim();
  if (ie) taxIdentifiers.registrationNumber = ie.toUpperCase() === 'ISENTO' ? 'ISENTO' : ie;
  return {
    taxClassification: values.regime,
    jurisdictionSettings: brSettingsPayload(values),
    ...(Object.keys(taxIdentifiers).length > 0 ? { taxIdentifiers } : {}),
  };
}

/** Why a field is not valid: the message key under `weldbooksBr.entity.errors`. */
export type BrEntityErrorCode =
  | 'cnpj'
  | 'cnpjChecksum'
  | 'ie'
  | 'cnae'
  | 'uf'
  | 'municipalityCode'
  | 'municipalityUf'
  | 'issRate'
  | 'nfeSeries'
  | 'pixKey'
  | 'pixCity'
  | 'percent'
  | 'amount'
  | 'regime'
  | 'cep';

export type BrEntityErrors = Partial<Record<keyof BrEntityValues | 'cnpj' | 'ie', BrEntityErrorCode>>;

/** CNPJ of the entity: empty is allowed (it can be filled in later). */
export function cnpjError(value: string): BrEntityErrorCode | null {
  if (value.trim() === '') return null;
  const problem = cnpjProblem(value);
  if (problem === 'format') return 'cnpj';
  return problem === 'checksum' ? 'cnpjChecksum' : null;
}

export function ieError(value: string): BrEntityErrorCode | null {
  return value.trim() === '' || isValidInscricaoEstadual(value) ? null : 'ie';
}

type BrEntityErrorContext = { entityType?: string | null; cnpj?: string; ie?: string };

/** The CNPJ / IE checks, only for the identifiers the caller passed. */
function addIdentifierErrors(errors: BrEntityErrors, context: BrEntityErrorContext): void {
  if (context.cnpj !== undefined) {
    const e = cnpjError(context.cnpj);
    if (e) errors.cnpj = e;
  }
  if (context.ie !== undefined) {
    const e = ieError(context.ie);
    if (e) errors.ie = e;
  }
}

/** The UF and municipality checks (the IBGE code must belong to the UF). */
function addLocationErrors(errors: BrEntityErrors, values: BrEntityValues): void {
  const uf = values.uf.trim();
  const state = uf ? findBrState(uf) : undefined;
  if (uf && !state) errors.uf = 'uf';
  const code = values.municipalityCode.trim();
  if (code) {
    if (!isValidMunicipalityCode(code)) errors.municipalityCode = 'municipalityCode';
    else if (state && code.slice(0, 2) !== state.ibge) errors.municipalityCode = 'municipalityUf';
  }
}

/** The CNAE, ISS rate, NF-e series and Pix checks. */
function addTaxSetupErrors(errors: BrEntityErrors, values: BrEntityValues): void {
  const cnae = values.cnae.trim();
  if (cnae && !/^\d{7}$|^\d{4}-\d\/\d{2}$/.test(cnae)) errors.cnae = 'cnae';
  const iss = values.issRate.trim();
  if (iss) {
    const n = parseNumber(iss);
    if (n === undefined || n < 2 || n > 5) errors.issRate = 'issRate';
  }
  const series = values.nfeSeries.trim();
  if (series && !/^\d{1,3}$/.test(series)) errors.nfeSeries = 'nfeSeries';
  const pix = values.pixKey.trim();
  if (pix && !isPlausiblePixKey(pix)) errors.pixKey = 'pixKey';
  if (values.pixCity.trim().length > 15) errors.pixCity = 'pixCity';
}

/** The CBS / IBS rates (0–30 %) and the 12-month payroll (not negative). */
function addReformErrors(errors: BrEntityErrors, values: BrEntityValues): void {
  for (const key of ['cbsRate', 'ibsRate'] as const) {
    const raw = values[key].trim();
    if (!raw) continue;
    const n = parseNumber(raw);
    if (n === undefined || n < 0 || n > 30) errors[key] = 'percent';
  }
  const payroll = values.payroll12m.trim();
  if (payroll) {
    const n = parseNumber(payroll);
    if (n === undefined || n < 0) errors.payroll12m = 'amount';
  }
}

/** The checks of the BR fields (everything optional, but what is filled in must be well formed). */
export function brEntityErrors(values: BrEntityValues, context: BrEntityErrorContext): BrEntityErrors {
  const errors: BrEntityErrors = {};
  addIdentifierErrors(errors, context);
  if (!allowedBrRegimes(context.entityType).includes(values.regime)) errors.regime = 'regime';
  addLocationErrors(errors, values);
  addTaxSetupErrors(errors, values);
  addReformErrors(errors, values);
  return errors;
}

/** A contact's CNPJ / CPF field: empty is allowed. */
export function contactTaxIdError(value: string): 'cnpj' | 'cpf' | 'cnpjChecksum' | 'cpfChecksum' | null {
  if (value.trim() === '') return null;
  const problem = brTaxIdProblem(value);
  if (!problem) return null;
  const isCpf = normalizeCnpj(value).length === 11 && /^\d+$/.test(normalizeCnpj(value));
  if (isCpf) return problem === 'checksum' ? 'cpfChecksum' : 'cpf';
  return problem === 'checksum' ? 'cnpjChecksum' : 'cnpj';
}
