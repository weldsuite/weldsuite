/**
 * Formatting helpers for documents and files: address lines, month names,
 * file names, and a guard around engine calls that may not exist yet.
 */

import type { HrPayrollAddress } from '@weldsuite/db/schema';
import { HrPayrollError } from '../shared';

/** Address as printed lines: `Dorpsstraat 1A`, `1234 AB Utrecht` (NL) or `1 Main St`, `Austin, TX 78701` (US). */
export function addressLines(address: HrPayrollAddress | null | undefined, country: 'NL' | 'US' | string): string[] {
  if (!address) return [];
  const lines: string[] = [];
  const street = [address.line1, address.houseNumber ? `${address.houseNumber}${address.houseNumberAddition ?? ''}` : null]
    .filter(Boolean)
    .join(country === 'US' ? ' ' : ' ')
    .trim();
  if (country === 'NL') {
    if (street) lines.push(street);
    if (address.line2) lines.push(address.line2);
    const city = [address.postalCode, address.city].filter(Boolean).join(' ');
    if (city) lines.push(city);
  } else {
    if (street) lines.push(street);
    if (address.line2) lines.push(address.line2);
    const cityLine = [address.city, [address.region, address.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (cityLine) lines.push(cityLine);
  }
  return lines;
}

const MONTHS = {
  nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
} as const;

export function monthName(month: number, lang: 'nl' | 'en'): string {
  return MONTHS[lang][month - 1] ?? String(month);
}

/** `Salaris april 2026` / `Salary April 2026` for a payment remittance. */
export function salaryRemittance(periodStart: string, lang: 'nl' | 'en'): string {
  const month = Number(periodStart.slice(5, 7));
  const year = periodStart.slice(0, 4);
  return `${lang === 'nl' ? 'Salaris' : 'Salary'} ${monthName(month, lang)} ${year}`;
}

/** `loonstrook-2026-04.pdf` (NL, by period month) / `payslip-2026-04-24.pdf` (US, by pay date). */
export function payslipFileName(country: string, period: { periodStart: string; payDate: string }): string {
  return country === 'NL' ? `loonstrook-${period.periodStart.slice(0, 7)}.pdf` : `payslip-${period.payDate}.pdf`;
}

export function annualStatementFileName(country: string, year: number): string {
  return country === 'NL' ? `jaaropgaaf-${year}.pdf` : `w2-${year}.pdf`;
}

/**
 * An id for a message or a payment: letters, digits and hyphens only. SEPA (the EPC character set) and the
 * Belastingdienst's message ids do not take an underscore; the builders would otherwise change it behind our back.
 */
export function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, '-');
}

/** Attachment header value with a safe file name. */
export function attachment(fileName: string): string {
  return `attachment; filename="${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`;
}

/**
 * Run an engine / builder call that another package implements. A builder
 * that is not there yet throws; that must read as "not available", not as a
 * server error.
 */
export function engineCall<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HrPayrollError) throw err;
    throw new HrPayrollError('ENGINE_UNAVAILABLE', `${what} is not available: ${err instanceof Error ? err.message : 'unknown error'}`, 503);
  }
}
