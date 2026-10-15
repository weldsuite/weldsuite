import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MapboxSuggestion } from '@/app/weldcalendar/lib/mapbox-search';
import { AddressFields } from './address-fields';
import type { PostalAddress } from './postal-address';

const { retrieveLocation } = vi.hoisted(() => ({ retrieveLocation: vi.fn() }));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: {
      accounting: {
        addressFields: new Proxy({}, { get: (_t, key) => String(key) }),
      },
    },
  }),
}));
vi.mock('@/app/weldcalendar/lib/mapbox-search', () => ({ retrieveLocation }));

const suggestion: MapboxSuggestion = {
  mapbox_id: 'addr_1',
  name: '1 Infinite Loop',
  full_address: '',
  place_formatted: 'Cupertino, California, United States',
  feature_type: 'address',
  context: { country: { country_code: 'us' }, region: { name: 'California', region_code: 'CA' }, place: { name: 'Cupertino' } },
};

// Stand-in for the Mapbox search input: a button that "picks" the suggestion,
// and a record of what it was asked to search.
const searched: Array<{ searchTypes?: string; country?: string }> = [];
vi.mock('@/app/weldcalendar/components/location-autocomplete', () => ({
  LocationAutocomplete: (props: {
    searchTypes?: string;
    country?: string;
    onSuggestionSelect?: (s: MapboxSuggestion, token: string) => void;
  }) => {
    searched.push({ searchTypes: props.searchTypes, country: props.country });
    return (
      <button type="button" onClick={() => props.onSuggestionSelect?.(suggestion, 'session-1')}>
        pick
      </button>
    );
  },
}));

describe('AddressFields · Mapbox street search', () => {
  it('searches street addresses in the chosen country, and fills the form from the pick', async () => {
    retrieveLocation.mockResolvedValue({ ...suggestion, context: { ...suggestion.context, postcode: { name: '95014' } } });
    const onChange = vi.fn<(next: PostalAddress) => void>();
    render(<AddressFields value={{ country: 'US', line2: 'Suite 5' }} onChange={onChange} idPrefix="t" />);

    expect(searched.at(-1)).toEqual({ searchTypes: 'address,poi', country: 'US' });

    fireEvent.click(screen.getByText('pick'));
    // No postcode in the suggestion, so its details are retrieved in the same session.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(retrieveLocation).toHaveBeenCalledWith('addr_1', 'session-1');
    expect(onChange).toHaveBeenLastCalledWith({
      line1: '1 Infinite Loop',
      line2: 'Suite 5',
      city: 'Cupertino',
      state: 'CA',
      postalCode: '95014',
      country: 'US',
    });
  });
});
