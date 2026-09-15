import type { PhoneNumberType } from './phone-pricing-keys';
import { PHONE_NUMBER_TYPES, PHONE_PRICING_SEED_COUNTRIES } from './phone-pricing-keys';

export interface TelnyxCountryCoverage {
  code?: string;
  numbers?: boolean;
  phone_number_type?: string[];
}

export interface SeedCombo {
  countryCode: string;
  numberType: PhoneNumberType;
  telnyxType: 'local' | 'toll_free' | 'mobile';
}

export function catalogNumberTypeFromTelnyx(raw: string): PhoneNumberType | null {
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'local') return 'local';
  if (normalized === 'toll_free') return 'toll-free';
  if (normalized === 'mobile') return 'mobile';
  return null;
}

export function telnyxTypeFromCatalog(type: PhoneNumberType): SeedCombo['telnyxType'] {
  if (type === 'toll-free') return 'toll_free';
  return type;
}

export function coverageTypes(entry: TelnyxCountryCoverage | undefined): Set<PhoneNumberType> {
  const types = new Set<PhoneNumberType>();
  for (const raw of entry?.phone_number_type ?? []) {
    const mapped = catalogNumberTypeFromTelnyx(raw);
    if (mapped) types.add(mapped);
  }
  return types;
}

export function seedCombosFromCoverage(
  coverageByCode: Map<string, TelnyxCountryCoverage>,
  countries: readonly string[] = PHONE_PRICING_SEED_COUNTRIES,
): SeedCombo[] {
  const combos: SeedCombo[] = [];
  for (const country of countries) {
    const entry = coverageByCode.get(country);
    const allowed = coverageTypes(entry);
    let types: PhoneNumberType[];
    if (allowed.size > 0) {
      types = PHONE_NUMBER_TYPES.filter((t) => allowed.has(t));
    } else if (entry && entry.numbers === false) {
      continue;
    } else {
      types = [...PHONE_NUMBER_TYPES];
    }
    for (const numberType of types) {
      combos.push({
        countryCode: country,
        numberType,
        telnyxType: telnyxTypeFromCatalog(numberType),
      });
    }
  }
  return combos;
}

export function medianMonthlyCost(values: number[]): string | null {
  const sorted = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return median.toFixed(2);
}

export function monthlyCostsFromAvailable(data: unknown[]): { costs: number[]; currency: string } {
  const costs: number[] = [];
  let currency = 'USD';
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const info = (row as { cost_information?: { monthly_cost?: string; currency?: string } })
      .cost_information;
    const n = Number.parseFloat(String(info?.monthly_cost ?? ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    costs.push(n);
    if (typeof info?.currency === 'string' && info.currency.trim()) {
      currency = info.currency.trim().toUpperCase();
    }
  }
  return { costs, currency };
}

export function parseCoverageMap(raw: unknown): Map<string, TelnyxCountryCoverage> {
  const map = new Map<string, TelnyxCountryCoverage>();
  if (!raw || typeof raw !== 'object') return map;
  const entries = Array.isArray(raw)
    ? raw.map((value) => [undefined, value] as const)
    : Object.entries(raw as Record<string, TelnyxCountryCoverage>);
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const fromField = typeof value.code === 'string' ? value.code.trim().toUpperCase() : '';
    const fromKey = typeof key === 'string' && /^[A-Z]{2}$/i.test(key) ? key.toUpperCase() : '';
    const code = fromField || fromKey;
    if (code) map.set(code, value);
  }
  return map;
}
