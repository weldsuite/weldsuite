export interface MapboxSuggestion {
  mapbox_id: string;
  name: string;
  full_address: string;
  place_formatted: string;
  feature_type?: string;
}

export function createSessionToken(): string {
  return crypto.randomUUID();
}

export async function searchLocation(
  query: string,
  sessionToken: string,
  options?: { limit?: number; language?: string; country?: string; types?: string },
): Promise<MapboxSuggestion[]> {
  const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
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

  const data = await res.json();
  return (data.suggestions ?? []).map((s: any) => ({
    mapbox_id: s.mapbox_id,
    name: s.name,
    full_address: s.full_address ?? '',
    place_formatted: s.place_formatted ?? '',
    feature_type: s.feature_type ?? '',
  }));
}
