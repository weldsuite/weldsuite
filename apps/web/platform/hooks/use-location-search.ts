import { useState, useEffect, useRef, useCallback } from 'react';
import { useDebounce } from './use-debounce';
import {
  searchLocation,
  createSessionToken,
  type MapboxSuggestion,
} from '@/app/weldcalendar/lib/mapbox-search';

interface UseLocationSearchOptions {
  debounceMs?: number;
  minLength?: number;
  /** Restrict Mapbox results to specific feature types (e.g. `'country'`). */
  types?: string;
  /** Restrict results to a given country (ISO 3166-1 alpha-2). */
  country?: string;
}

export function useLocationSearch(options?: UseLocationSearchOptions) {
  const { debounceMs = 0, minLength = 1, types, country } = options ?? {};

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<MapboxSuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const sessionTokenRef = useRef(createSessionToken());

  const debouncedQuery = useDebounce(query, debounceMs);

  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < minLength) {
      setSuggestions([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    searchLocation(debouncedQuery, sessionTokenRef.current, { types, country }).then(
      (results) => {
        if (!cancelled) {
          setSuggestions(results);
          setIsSearching(false);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, minLength, types, country]);

  const search = useCallback((q: string) => {
    setQuery(q);
    if (!q) {
      setSuggestions([]);
      setIsSearching(false);
    }
  }, []);

  const clear = useCallback(() => {
    setQuery('');
    setSuggestions([]);
    setIsSearching(false);
  }, []);

  const resetSession = useCallback(() => {
    sessionTokenRef.current = createSessionToken();
  }, []);

  return { suggestions, isSearching, search, clear, resetSession };
}
