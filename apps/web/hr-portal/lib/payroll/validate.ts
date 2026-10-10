/**
 * Client-side checks for the payroll details form. They only catch typing
 * mistakes early: the API validates everything again and its message is shown
 * when it disagrees.
 */

/** A BSN passes the "elfproef": 9 digits, weighted 9…2 and −1, divisible by 11 (8 digits get a leading zero). */
export function isValidBsn(input: string): boolean {
  const digits = input.replace(/[\s.-]/g, '');
  if (!/^\d{8,9}$/.test(digits)) return false;
  const padded = digits.padStart(9, '0');
  if (/^0+$/.test(padded)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    const weight = i === 8 ? -1 : 9 - i;
    sum += Number(padded[i]) * weight;
  }
  return sum % 11 === 0;
}

/** A US Social Security number: 9 digits, with or without dashes. */
export function isValidSsn(input: string): boolean {
  return /^\d{3}-?\d{2}-?\d{4}$/.test(input.trim()) || /^\d{9}$/.test(input.trim());
}

/** IBAN with the mod-97 check digits. */
export function isValidIban(input: string): boolean {
  const iban = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidRoutingNumber(input: string): boolean {
  return /^\d{9}$/.test(input.trim());
}

export function isValidAccountNumber(input: string): boolean {
  return /^\d{4,17}$/.test(input.trim());
}

/** A calendar date typed into `<input type="date">`: `YYYY-MM-DD` and a day that exists. */
export function isValidIsoDate(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const date = new Date(`${input}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === input;
}

/**
 * An amount typed into a money field, rounded to cents. An empty field counts
 * as 0 (the forms ask for "0 if none"); anything that is not a number of zero
 * or more gives null.
 */
export function parseAmount(input: string): number | null {
  const trimmed = input.trim().replace(',', '.');
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 10_000_000) return null;
  return Math.round(value * 100) / 100;
}

/** A whole number of allowances from 0 to 99; an empty field is "not given" (undefined), anything else invalid is null. */
export function parseAllowances(input: string): number | null | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  return Number(trimmed);
}
