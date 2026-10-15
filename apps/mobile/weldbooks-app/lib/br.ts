/**
 * Brazil specifics the forms need: CNPJ checks and the legal forms and tax
 * regimes of a Brazilian company.
 *
 * The app doesn't import `@weldsuite/books-domain` (server code), so the rules
 * mirror `packages/domains/books/src/jurisdictions/br/` (`identifiers.ts`,
 * `regimes.ts`). books-api checks every value again, so these only catch
 * typos before a request is sent.
 */

export const BR_ENTITY_TYPES = ['mei', 'ei', 'slu', 'ltda', 'sa'] as const;
export type BrEntityType = (typeof BR_ENTITY_TYPES)[number];

export const BR_TAX_REGIMES = ['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real'] as const;
export type BrTaxRegime = (typeof BR_TAX_REGIMES)[number];

/** The regime a company is in until it says otherwise. */
export const DEFAULT_BR_REGIME: BrTaxRegime = 'simples_nacional';

/** Which regimes a legal form can be in: only a MEI is in the SIMEI, and an S.A. can't opt for the Simples. */
export function allowedBrRegimes(entityType: string | null | undefined): readonly BrTaxRegime[] {
  if (entityType === 'mei') return ['mei'];
  if (entityType === 'sa') return ['lucro_presumido', 'lucro_real'];
  return ['simples_nacional', 'lucro_presumido', 'lucro_real'];
}

/** `value` when the legal form allows it, else the form's first (default) regime. */
export function validBrRegime(entityType: string | null | undefined, value: string | null | undefined): BrTaxRegime {
  const allowed = allowedBrRegimes(entityType);
  const found = allowed.find((regime) => regime === value);
  if (found) return found;
  return allowed.includes(DEFAULT_BR_REGIME) ? DEFAULT_BR_REGIME : allowed[0];
}

// ---------------------------------------------------------------------------
// CNPJ
// ---------------------------------------------------------------------------

/** 14 characters: 12 letters or digits (letters since July 2026), then 2 numeric check digits. */
const CNPJ_RE = /^[0-9A-Z]{12}\d{2}$/;
const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Strip the mask (dots, slash, dash, spaces) and upper-case. */
export function normalizeCnpj(value: string): string {
  return value.replaceAll(/[\s./-]/g, '').toUpperCase();
}

/** Modulo-11 check digit over each character's ASCII code minus 48 (digits keep their value, A..Z are 17..42). */
function checkDigit(values: readonly number[], weights: readonly number[]): number {
  const sum = values.reduce((total, value, index) => total + value * weights[index], 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** The two check digits of a CNPJ from its first 12 characters (already normalized). */
export function cnpjCheckDigits(first12: string): string {
  const values = [...first12].map((char) => (char.codePointAt(0) ?? 48) - 48);
  const first = checkDigit(values, CNPJ_WEIGHTS_1);
  const second = checkDigit([...values, first], CNPJ_WEIGHTS_2);
  return `${first}${second}`;
}

/** `00.000.000/0000-00` for a complete CNPJ; whatever was given otherwise. */
export function formatCnpj(normalized: string): string {
  if (normalized.length !== 14) return normalized;
  return `${normalized.slice(0, 2)}.${normalized.slice(2, 5)}.${normalized.slice(5, 8)}/${normalized.slice(8, 12)}-${normalized.slice(12)}`;
}

/** What a CNPJ field holds while typing: upper-cased, capped at 14 characters and masked once complete. */
export function formatCnpjInput(text: string): string {
  return formatCnpj(normalizeCnpj(text).slice(0, 14));
}

/** Why a CNPJ is wrong: the wrong shape, or check digits that don't match. `null` when it is fine or empty. */
export function cnpjProblem(value: string): 'format' | 'checkDigits' | null {
  const normalized = normalizeCnpj(value);
  if (!normalized) return null;
  if (!CNPJ_RE.test(normalized) || /^(.)\1{13}$/.test(normalized)) return 'format';
  return cnpjCheckDigits(normalized.slice(0, 12)) === normalized.slice(12) ? null : 'checkDigits';
}
