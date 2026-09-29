/**
 * Map order shipping addresses onto Sendcloud v3 address fields.
 */

const COUNTRY_NAMES: Record<string, string> = {
  netherlands: 'NL',
  nederland: 'NL',
  belgium: 'BE',
  belgie: 'BE',
  belgië: 'BE',
  germany: 'DE',
  deutschland: 'DE',
  duitsland: 'DE',
  france: 'FR',
  frankrijk: 'FR',
  'united kingdom': 'GB',
  'great britain': 'GB',
  uk: 'GB',
  'united states': 'US',
  usa: 'US',
  spain: 'ES',
  spanje: 'ES',
  italy: 'IT',
  italië: 'IT',
  austria: 'AT',
  oostenrijk: 'AT',
  poland: 'PL',
  polen: 'PL',
};

export function toCountryCode(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_NAMES[trimmed.toLowerCase()] ?? null;
}

export function splitStreet(line1?: string | null): { addressLine1: string; houseNumber: string } {
  const value = (line1 ?? '').trim();
  if (!value) return { addressLine1: '', houseNumber: '1' };
  const match = value.match(/^(.*?)[\s,]+(\d+\s*[a-zA-Z]?)$/);
  if (match) return { addressLine1: match[1]!.trim(), houseNumber: match[2]!.trim() };
  return { addressLine1: value, houseNumber: '1' };
}

export interface OrderAddressLike {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  name?: string | null;
  phone?: string | null;
}

export function toSendcloudToAddress(params: {
  address?: OrderAddressLike | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): {
  name: string;
  address_line_1: string;
  address_line_2?: string;
  house_number: string;
  postal_code: string;
  city: string;
  country_code: string;
  email?: string;
  phone_number?: string;
  state_province_code?: string;
} {
  const address = params.address ?? {};
  const street = splitStreet(address.line1);
  const country = toCountryCode(address.country);
  const name = (address.name || params.name || '').trim();
  const postal = (address.postalCode || '').trim();
  const city = (address.city || '').trim();
  if (!name || !street.addressLine1 || !postal || !city || !country) {
    const missing = [
      !name && 'name',
      !street.addressLine1 && 'street',
      !postal && 'postal code',
      !city && 'city',
      !country && 'country',
    ].filter(Boolean);
    throw new Error(`Recipient address is incomplete (${missing.join(', ')})`);
  }
  return {
    name,
    address_line_1: street.addressLine1,
    address_line_2: address.line2?.trim() || undefined,
    house_number: street.houseNumber,
    postal_code: postal,
    city,
    country_code: country,
    email: params.email?.trim() || undefined,
    phone_number: (address.phone || params.phone || undefined)?.trim() || undefined,
    state_province_code: address.state?.trim() || undefined,
  };
}
