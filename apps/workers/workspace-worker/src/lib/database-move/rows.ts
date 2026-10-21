/**
 * Narrowing readers for result rows. Drivers disagree on types (neon-http
 * hands back bigint as string, PGlite as number), so the engine casts every
 * number to text in SQL and parses it here; these helpers are the one place
 * that turns `unknown` cells into typed values.
 */

import type { SqlRow } from './types';

export function readString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`Expected a string in column "${key}"`);
}

export function readNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return readString(row, key);
}

export function readInt(row: SqlRow, key: string): number {
  const parsed = Number(readString(row, key));
  if (!Number.isSafeInteger(parsed)) throw new Error(`Column "${key}" is not a safe integer`);
  return parsed;
}

export function readBool(row: SqlRow, key: string): boolean {
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;
  throw new Error(`Expected a boolean in column "${key}"`);
}

/** Parse a column holding JSON text (`json_agg(...)::text`) into an unknown value. */
export function readJson(row: SqlRow, key: string): unknown {
  const value = row[key];
  // A driver may already have parsed a json column; text is the contract, objects are tolerated.
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  if (value !== null && typeof value === 'object') return value;
  throw new Error(`Expected JSON in column "${key}"`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new Error(`Expected an array of strings for ${what}`);
  }
  return value;
}
