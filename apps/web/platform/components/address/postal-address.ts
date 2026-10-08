/**
 * The postal address shape used across WeldSuite: CRM parties, orders and
 * (since the WeldBooks ledger foundations) accounting entities, contacts,
 * invoices and bills. `state` holds a state, province or region; for a US
 * address it is the two-letter USPS code. `country` is an ISO 3166-1 alpha-2
 * code.
 */
export interface PostalAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export const POSTAL_ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;

export const EMPTY_POSTAL_ADDRESS: PostalAddress = {
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
};

/** True when no field holds anything but whitespace. */
export function isPostalAddressEmpty(address: PostalAddress | null | undefined): boolean {
  if (!address) return true;
  return POSTAL_ADDRESS_FIELDS.every((field) => !address[field]?.trim());
}

/**
 * Trim every field and drop the blank ones, for sending to an API. Returns
 * `undefined` when nothing is left, so an untouched address section isn't
 * sent as an object full of empty strings.
 */
export function cleanPostalAddress(address: PostalAddress | null | undefined): PostalAddress | undefined {
  if (!address) return undefined;
  const cleaned: PostalAddress = {};
  for (const field of POSTAL_ADDRESS_FIELDS) {
    const value = address[field]?.trim();
    if (value) cleaned[field] = field === 'country' ? value.toUpperCase() : value;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/** Fill every field with a string so the address can back controlled inputs. */
export function toPostalAddressFormValue(address: PostalAddress | null | undefined): PostalAddress {
  return {
    line1: address?.line1 ?? '',
    line2: address?.line2 ?? '',
    city: address?.city ?? '',
    state: address?.state ?? '',
    postalCode: address?.postalCode ?? '',
    country: address?.country ?? '',
  };
}

/**
 * Printable lines for an address: street lines, then the locality line, then
 * the country name. A US address prints "City, ST 12345"; elsewhere the postal
 * code goes first ("1012 AB Amsterdam") and the region on its own line.
 */
export function formatPostalAddressLines(
  address: PostalAddress | null | undefined,
  options: { countryName?: (code: string) => string; omitCountry?: string | null } = {},
): string[] {
  if (!address) return [];
  const line1 = address.line1?.trim();
  const line2 = address.line2?.trim();
  const city = address.city?.trim();
  const state = address.state?.trim();
  const postalCode = address.postalCode?.trim();
  const country = address.country?.trim().toUpperCase();

  const lines: string[] = [];
  if (line1) lines.push(line1);
  if (line2) lines.push(line2);

  if (country === 'US' || country === 'CA') {
    const cityState = [city, state].filter(Boolean).join(', ');
    const locality = [cityState, postalCode].filter(Boolean).join(' ');
    if (locality) lines.push(locality);
  } else {
    const locality = [postalCode, city].filter(Boolean).join(' ');
    if (locality) lines.push(locality);
    if (state) lines.push(state);
  }

  if (country && country !== options.omitCountry?.toUpperCase()) {
    lines.push(options.countryName ? options.countryName(country) : country);
  }
  return lines;
}
