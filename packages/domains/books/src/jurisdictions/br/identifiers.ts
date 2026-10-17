import type { TaxIdentifierValidation } from '../types';

/**
 * Brazilian registration numbers.
 *
 * CNPJ: 14 characters, the first 12 alphanumeric since July 2026 (IN RFB
 * 2.229/2024) and the last 2 numeric check digits. The check digits use the
 * same modulo-11 scheme as before, over each character's ASCII code minus 48,
 * so digits keep their value and A..Z count as 17..42. A numeric CNPJ is
 * therefore validated by the same function.
 *
 * CPF: 11 digits, two modulo-11 check digits.
 */

const CNPJ_RE = /^[0-9A-Z]{12}\d{2}$/;
const CPF_RE = /^\d{11}$/;

/** Strip the mask (dots, slash, dash, spaces) and upper-case. */
export function normalizeCnpj(value: string): string {
  return value.replace(/[\s./-]/g, '').toUpperCase();
}

export function normalizeCpf(value: string): string {
  return value.replace(/[\s.-]/g, '');
}

function mod11Digit(values: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * weights[i];
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** The two check digits of a CNPJ from its first 12 characters (already normalized). */
export function cnpjCheckDigits(first12: string): string {
  const values = [...first12].map((ch) => ch.charCodeAt(0) - 48);
  const d1 = mod11Digit(values, CNPJ_WEIGHTS_1);
  const d2 = mod11Digit([...values, d1], CNPJ_WEIGHTS_2);
  return `${d1}${d2}`;
}

export function formatCnpj(normalized: string): string {
  return `${normalized.slice(0, 2)}.${normalized.slice(2, 5)}.${normalized.slice(5, 8)}/${normalized.slice(8, 12)}-${normalized.slice(12)}`;
}

export function validateCnpj(value: string): TaxIdentifierValidation {
  const normalized = normalizeCnpj(value);
  if (!CNPJ_RE.test(normalized)) {
    return { valid: false, error: 'CNPJ must have 14 characters (e.g. 11.222.333/0001-81)' };
  }
  if (/^(.)\1{13}$/.test(normalized)) {
    return { valid: false, error: 'CNPJ is not valid' };
  }
  if (cnpjCheckDigits(normalized.slice(0, 12)) !== normalized.slice(12)) {
    return { valid: false, error: 'CNPJ check digits are wrong: check the number for a typo' };
  }
  return { valid: true, formatted: formatCnpj(normalized) };
}

export function cpfCheckDigits(first9: string): string {
  const values = [...first9].map(Number);
  const dv = (digits: number[], startWeight: number) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) sum += digits[i] * (startWeight - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  const d1 = dv(values, 10);
  const d2 = dv([...values, d1], 11);
  return `${d1}${d2}`;
}

export function formatCpf(normalized: string): string {
  return `${normalized.slice(0, 3)}.${normalized.slice(3, 6)}.${normalized.slice(6, 9)}-${normalized.slice(9)}`;
}

export function validateCpf(value: string): TaxIdentifierValidation {
  const normalized = normalizeCpf(value);
  if (!CPF_RE.test(normalized)) {
    return { valid: false, error: 'CPF must have 11 digits (e.g. 529.982.247-25)' };
  }
  if (/^(\d)\1{10}$/.test(normalized)) {
    return { valid: false, error: 'CPF is not valid' };
  }
  if (cpfCheckDigits(normalized.slice(0, 9)) !== normalized.slice(9)) {
    return { valid: false, error: 'CPF check digits are wrong: check the number for a typo' };
  }
  return { valid: true, formatted: formatCpf(normalized) };
}

/** A CNPJ (company) or CPF (person), told apart by length. */
export function validateCnpjOrCpf(value: string): TaxIdentifierValidation & { kind?: 'cnpj' | 'cpf' } {
  const compact = normalizeCnpj(value);
  if (compact.length === 11 && /^\d+$/.test(compact)) return { ...validateCpf(compact), kind: 'cpf' };
  return { ...validateCnpj(compact), kind: 'cnpj' };
}

/**
 * Inscrição Estadual: every state has its own length and check digit, so only
 * the shape is checked here (2 to 14 digits), or "ISENTO" for an exempt buyer.
 */
export function validateInscricaoEstadual(value: string): TaxIdentifierValidation {
  const trimmed = value.trim().toUpperCase();
  if (trimmed === 'ISENTO') return { valid: true, formatted: 'ISENTO' };
  const digits = trimmed.replace(/[\s./-]/g, '');
  if (!/^\d{2,14}$/.test(digits)) {
    return { valid: false, error: 'Inscrição Estadual must be 2 to 14 digits, or ISENTO' };
  }
  return { valid: true, formatted: digits };
}

/** CEP: 8 digits, printed 00000-000. */
export function normalizeCep(value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : undefined;
}
