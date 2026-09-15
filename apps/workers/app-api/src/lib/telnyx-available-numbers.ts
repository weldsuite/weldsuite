/**
 * Normalize Telnyx `available_phone_numbers` rows into the shape the
 * purchase UI expects (Twilio-era `iso_country` / `locality` / `capabilities`).
 *
 * Telnyx puts the country on `region_information[]` (`region_type: country_code`)
 * and has no `iso_country` field. Without this mapping the new-number page
 * cannot match Stripe pricing and labels every result "Not available".
 */

export interface TelnyxRegionInfo {
  region_name?: string;
  region_type?: string;
}

export interface TelnyxAvailableNumber {
  phone_number?: string;
  friendly_name?: string;
  iso_country?: string;
  locality?: string;
  region?: string;
  phone_number_type?: string;
  region_information?: TelnyxRegionInfo[];
  cost_information?: { currency?: string; monthly_cost?: string; upfront_cost?: string };
  features?: Array<{ name?: string }>;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
  [key: string]: unknown;
}

export interface MappedAvailableNumber {
  phone_number: string;
  friendly_name: string;
  iso_country: string;
  locality?: string;
  region?: string;
  phone_number_type?: string;
  region_information?: TelnyxRegionInfo[];
  cost_information?: { currency: string; monthly_cost: string; upfront_cost: string };
  features?: Array<{ name: string }>;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
}

function regionName(
  regions: TelnyxRegionInfo[],
  type: string | string[],
): string | undefined {
  const types = Array.isArray(type) ? type : [type];
  const hit = regions.find((r) => r.region_type && types.includes(r.region_type));
  const name = hit?.region_name?.trim();
  return name || undefined;
}

export function mapTelnyxAvailableNumber(
  row: TelnyxAvailableNumber,
  fallbackCountry: string,
): MappedAvailableNumber | null {
  const phone = typeof row.phone_number === 'string' ? row.phone_number.trim() : '';
  if (!phone) return null;

  const regions = Array.isArray(row.region_information) ? row.region_information : [];
  const iso =
    (typeof row.iso_country === 'string' && row.iso_country.trim()) ||
    regionName(regions, 'country_code') ||
    fallbackCountry;

  const features = Array.isArray(row.features)
    ? row.features.map((f) => String(f?.name ?? '').toLowerCase()).filter(Boolean)
    : [];

  const cost = row.cost_information;

  return {
    phone_number: phone,
    friendly_name: (typeof row.friendly_name === 'string' && row.friendly_name.trim()) || phone,
    iso_country: iso.toUpperCase(),
    locality:
      (typeof row.locality === 'string' && row.locality) ||
      regionName(regions, ['location', 'rate_center']),
    region: (typeof row.region === 'string' && row.region) || regionName(regions, 'state'),
    phone_number_type: row.phone_number_type,
    region_information: regions,
    cost_information:
      cost && (cost.monthly_cost || cost.upfront_cost)
        ? {
            currency: cost.currency || 'USD',
            monthly_cost: String(cost.monthly_cost ?? '0'),
            upfront_cost: String(cost.upfront_cost ?? '0'),
          }
        : undefined,
    features: features.map((name) => ({ name })),
    capabilities: {
      voice: Boolean(row.capabilities?.voice) || features.includes('voice'),
      sms: Boolean(row.capabilities?.sms) || features.includes('sms'),
      mms: Boolean(row.capabilities?.mms) || features.includes('mms'),
    },
  };
}

export function normalizeNumberType(type: string): string {
  return type.trim().toLowerCase().replace(/_/g, '-');
}

export function pricingLookupKey(countryCode: string, numberType: string): string {
  return `${countryCode.trim().toUpperCase()}:${normalizeNumberType(numberType)}`;
}
