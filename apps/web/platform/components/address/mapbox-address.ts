/**
 * Mapbox Search Box results → the shared `PostalAddress` shape, so a picked
 * suggestion fills street, city, state, postal code and country the same way
 * everywhere (address forms, the record panels, the grid's location cells).
 *
 * `country` is the ISO 3166-1 alpha-2 code, like every stored address. For a
 * US address `state` is the USPS code (what the US state picker stores);
 * elsewhere it is the region's name.
 */

import type { MapboxSuggestion } from '@/app/weldcalendar/lib/mapbox-search';
import { COUNTRY_CODES, countryName } from './countries';
import type { PostalAddress } from './postal-address';

/** Feature types whose result is a street address (or a place at one). */
const STREET_LEVEL = new Set(['address', 'street', 'poi']);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** ISO-2 code for an English country name ("Germany" → "DE"), when it is one. */
function countryCodeForName(name: string | undefined): string | undefined {
  const wanted = clean(name)?.toLowerCase();
  if (!wanted) return undefined;
  return COUNTRY_CODES.find((code) => countryName(code, 'en').toLowerCase() === wanted);
}

/** True when the suggestion lacks details `/retrieve` would add (a street result without a postcode). */
export function needsMapboxRetrieve(s: MapboxSuggestion): boolean {
  return STREET_LEVEL.has(s.feature_type ?? '') && !s.context?.postcode?.name;
}

export function mapboxToPostalAddress(s: MapboxSuggestion): PostalAddress {
  const ctx = s.context ?? {};
  const type = s.feature_type ?? '';
  const country =
    clean(ctx.country?.country_code)?.toUpperCase() ??
    countryCodeForName(type === 'country' ? s.name : ctx.country?.name);
  const regionName = type === 'region' ? s.name : ctx.region?.name;
  const state =
    country === 'US' ? clean(ctx.region?.region_code)?.toUpperCase() ?? clean(regionName) : clean(regionName);
  const city = type === 'place' ? s.name : ctx.place?.name ?? ctx.locality?.name;

  const address: PostalAddress = { country };
  if (type === 'country') return dropEmpty(address);
  address.state = state;
  if (type === 'region') return dropEmpty(address);
  address.city = clean(city);
  address.postalCode = type === 'postcode' ? clean(s.name) : clean(ctx.postcode?.name);
  if (STREET_LEVEL.has(type)) {
    // A POI's name is the business; its street is `address`.
    address.line1 = clean(type === 'poi' ? s.address ?? ctx.address?.name : s.address ?? ctx.address?.name ?? s.name);
  }
  return dropEmpty(address);
}

function dropEmpty(address: PostalAddress): PostalAddress {
  return Object.fromEntries(Object.entries(address).filter(([, v]) => !!v)) as PostalAddress;
}
