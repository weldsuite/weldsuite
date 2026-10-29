import { publicEnv } from '@/lib/runtime-config';
/**
 * Where a result sits, as the Search Box API reports it. Only the parts a
 * postal address needs; every part is optional (a country has no place).
 */
export interface MapboxContext {
  country?: { name?: string; country_code?: string };
  region?: { name?: string; region_code?: string };
  postcode?: { name?: string };
  place?: { name?: string };
  locality?: { name?: string };
  address?: { name?: string; address_number?: string; street_name?: string };
  street?: { name?: string };
}

export interface MapboxSuggestion {
  mapbox_id: string;
  name: string;
  full_address: string;
  place_formatted: string;
  feature_type?: string;
  /** Street address line, for `address` / `poi` results. */
  address?: string;
  context?: MapboxContext;
}

interface RawSuggestion {
  mapbox_id: string;
  name: string;
  full_address?: string;
  place_formatted?: string;
  feature_type?: string;
  address?: string;
  context?: MapboxContext;
}

function toSuggestion(s: RawSuggestion): MapboxSuggestion {
  return {
    mapbox_id: s.mapbox_id,
    name: s.name,
    full_address: s.full_address ?? '',
    place_formatted: s.place_formatted ?? '',
    feature_type: s.feature_type ?? '',
    address: s.address,
    context: s.context,
  };
}

export function createSessionToken(): string {
  return crypto.randomUUID();
}

export async function searchLocation(
  query: string,
  sessionToken: string,
  options?: { limit?: number; language?: string; country?: string; types?: string },
): Promise<MapboxSuggestion[]> {
  const token = publicEnv('VITE_MAPBOX_ACCESS_TOKEN');
  if (!token) return [];

  const params = new URLSearchParams({
    q: query,
    access_token: token,
    session_token: sessionToken,
    limit: String(options?.limit ?? 6),
    // Caller may narrow the result set (e.g. `country` for a country-only
    // field). Defaults to the full place hierarchy.
    types: options?.types ?? 'country,region,place,address,poi',
  });

  if (options?.language) params.set('language', options.language);
  if (options?.country) params.set('country', options.country);

  const res = await fetch(
    `https://api.mapbox.com/search/searchbox/v1/suggest?${params}`,
  );

  if (!res.ok) return [];

  const data: { suggestions?: RawSuggestion[] } = await res.json();
  return (data.suggestions ?? []).map(toSuggestion);
}

/**
 * The full details of a suggestion (`/retrieve`), in the same session as the
 * `/suggest` calls that found it. A suggestion can leave out parts of its
 * context (often the postcode); the retrieved feature has them all. Null when
 * there is no token or the call fails.
 */
export async function retrieveLocation(mapboxId: string, sessionToken: string): Promise<MapboxSuggestion | null> {
  const token = publicEnv('VITE_MAPBOX_ACCESS_TOKEN');
  if (!token) return null;
  const params = new URLSearchParams({ access_token: token, session_token: sessionToken });
  try {
    const res = await fetch(
      `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(mapboxId)}?${params}`,
    );
    if (!res.ok) return null;
    const data: { features?: Array<{ properties?: RawSuggestion }> } = await res.json();
    const properties = data.features?.[0]?.properties;
    return properties ? toSuggestion({ ...properties, mapbox_id: properties.mapbox_id ?? mapboxId }) : null;
  } catch {
    return null;
  }
}
