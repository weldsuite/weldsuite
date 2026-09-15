export const DEFAULT_PHONE_PRICING_COUNTRY = '*';
export const DEFAULT_PHONE_PRICING_TYPE = '*';

export function isDefaultTelephonyPricing(countryCode: string, numberType: string): boolean {
  return countryCode.trim() === DEFAULT_PHONE_PRICING_COUNTRY
    && numberType.trim().toLowerCase().replace(/_/g, '-') === DEFAULT_PHONE_PRICING_TYPE;
}

export function parseCountryCode(
  raw: string,
): { ok: true; countryCode: string } | { ok: false } {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return { ok: false };
  return { ok: true, countryCode: code };
}

export const PHONE_NUMBER_TYPES = ['local', 'toll-free', 'mobile'] as const;
export type PhoneNumberType = (typeof PHONE_NUMBER_TYPES)[number];

export function parseNumberType(
  raw: string,
): { ok: true; numberType: PhoneNumberType } | { ok: false } {
  const type = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!PHONE_NUMBER_TYPES.includes(type as PhoneNumberType)) return { ok: false };
  return { ok: true, numberType: type as PhoneNumberType };
}
