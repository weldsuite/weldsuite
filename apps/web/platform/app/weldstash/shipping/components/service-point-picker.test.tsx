import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { ServicePoint, ServicePointChoice } from '@weldsuite/app-api-client/schemas/shipping';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  params: null as unknown,
  carrierId: undefined as string | undefined,
  data: undefined as unknown[] | undefined,
  isFetching: false,
  isError: false,
  isSuccess: true,
  error: null as Error | null,
}));

vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useServicePoints: (carrierId: string | undefined, params: unknown) => {
    state.carrierId = carrierId;
    state.params = params;
    return {
      data: params ? state.data : undefined,
      isFetching: state.isFetching,
      isError: state.isError,
      isSuccess: params ? state.isSuccess : false,
      error: state.error,
    };
  },
}));

import { ServicePointPicker, formatServicePointAddress } from './service-point-picker';

const t = en.weldstash.shipping.labels;
const a = en.weldstash.shipping.address;

const near: ServicePoint = {
  id: 'sp_1',
  name: 'Kiosk Centraal',
  address: { street: 'Stationsplein', houseNumber: '1', houseNumberSuffix: 'B', postalCode: '1012AB', city: 'Amsterdam' },
  distanceMeters: 450.4,
  latitude: null,
  longitude: null,
  openingHours: [],
  locker: false,
  networkId: 'PNPNL-01',
};
const far: ServicePoint = {
  id: 'sp_2',
  name: 'Locker Noord',
  address: { street: 'Noorderlaan', postalCode: '1034XX', city: 'Amsterdam' },
  distanceMeters: 2340,
  latitude: null,
  longitude: null,
  openingHours: [],
  locker: true,
  networkId: null,
};
const unknownDistance: ServicePoint = { ...far, id: 'sp_3', name: 'Shop Zuid', locker: false, distanceMeters: null };

function renderPicker(props: Partial<Parameters<typeof ServicePointPicker>[0]> = {}) {
  const onChange = vi.fn();
  renderWithProviders(
    <ServicePointPicker carrierId="car_1" country="NL" defaultPostalCode="1012LG" defaultHouseNumber="12" value={null} onChange={onChange} {...props} />,
  );
  return { onChange };
}

const postal = () => screen.getByLabelText(a.postalCode);
const houseNumber = () => screen.getByLabelText(a.houseNumber);
const searchButton = () => screen.getByRole('button', { name: new RegExp(t.servicePointSearch) });

beforeEach(() => {
  state.params = null;
  state.carrierId = undefined;
  state.data = [near, far, unknownDistance];
  state.isFetching = false;
  state.isError = false;
  state.isSuccess = true;
  state.error = null;
});

describe('formatServicePointAddress', () => {
  it('joins street, number, postal code and city', () => {
    expect(formatServicePointAddress(near.address)).toBe('Stationsplein 1B, 1012AB Amsterdam');
    expect(formatServicePointAddress(far.address)).toBe('Noorderlaan, 1034XX Amsterdam');
    expect(formatServicePointAddress({ city: 'Utrecht' })).toBe('Utrecht');
  });

  it('is empty without an address', () => {
    expect(formatServicePointAddress(null)).toBe('');
    expect(formatServicePointAddress(undefined)).toBe('');
  });
});

describe('ServicePointPicker', () => {
  it('prefills the search from the recipient and does not search until asked', () => {
    renderPicker();
    expect(postal()).toHaveValue('1012LG');
    expect(houseNumber()).toHaveValue('12');
    expect(state.params).toBeNull();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('searches the carrier by postal code and house number', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.clear(postal());
    await user.type(postal(), ' 3511AB ');
    await user.clear(houseNumber());
    await user.type(houseNumber(), '7');
    await user.click(searchButton());
    expect(state.carrierId).toBe('car_1');
    expect(state.params).toEqual({ country: 'NL', postalCode: '3511AB', houseNumber: '7', limit: 10 });
  });

  it('leaves the house number out when it is empty', async () => {
    const user = userEvent.setup();
    renderPicker({ defaultHouseNumber: '' });
    await user.click(searchButton());
    expect(state.params).toEqual({ country: 'NL', postalCode: '1012LG', houseNumber: undefined, limit: 10 });
  });

  it('searches on Enter in either field', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(postal(), '{Enter}');
    expect(state.params).toMatchObject({ postalCode: '1012LG' });
    state.params = null;
    await user.type(houseNumber(), '{Enter}');
    expect(state.params).toMatchObject({ houseNumber: '12' });
  });

  it('does not search without a postal code', async () => {
    const user = userEvent.setup();
    renderPicker({ defaultPostalCode: '' });
    expect(searchButton()).toBeDisabled();
    await user.type(houseNumber(), '{Enter}');
    expect(state.params).toBeNull();
  });

  it('lists the results with distance and locker badge', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(searchButton());
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByText('Kiosk Centraal')).toBeInTheDocument();
    expect(screen.getByText('Stationsplein 1B, 1012AB Amsterdam')).toBeInTheDocument();
    expect(screen.getByText(t.servicePointDistance.replace('{distance}', '450 m'))).toBeInTheDocument();
    expect(screen.getByText(t.servicePointDistance.replace('{distance}', '2.3 km'))).toBeInTheDocument();
    expect(screen.getAllByText(t.servicePointLocker)).toHaveLength(1);
    expect(screen.getAllByText(/ away$/)).toHaveLength(2);
  });

  it('reports the chosen service point', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    await user.click(searchButton());
    await user.click(screen.getByRole('radio', { name: /Locker Noord/ }));
    const expected: ServicePointChoice = { id: 'sp_2', name: 'Locker Noord', address: far.address, networkId: null };
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('says when nothing was found', async () => {
    const user = userEvent.setup();
    state.data = [];
    renderPicker();
    await user.click(searchButton());
    expect(screen.getByText(t.servicePointNone)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('shows the error message, or the generic one when it has none', async () => {
    const user = userEvent.setup();
    state.isError = true;
    state.isSuccess = false;
    state.error = new Error('Carrier down');
    renderPicker();
    await user.click(searchButton());
    expect(screen.getByText('Carrier down')).toBeInTheDocument();
  });

  it('falls back to the generic error line', async () => {
    const user = userEvent.setup();
    state.isError = true;
    state.isSuccess = false;
    state.error = new Error('');
    renderPicker();
    await user.click(searchButton());
    expect(screen.getByText(t.servicePointError)).toBeInTheDocument();
  });

  it('disables the search button while fetching', async () => {
    const user = userEvent.setup();
    state.isFetching = true;
    renderPicker();
    expect(searchButton()).toBeDisabled();
    await user.type(postal(), 'x');
  });

  it('marks the group invalid', () => {
    const { container } = (renderPicker({ invalid: true }), { container: document.body });
    expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });

  it('shows the chosen service point and lets the user clear it', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: { id: 'sp_1', name: 'Kiosk Centraal', address: near.address, networkId: 'PNPNL-01' } });
    expect(screen.getByText('Kiosk Centraal')).toBeInTheDocument();
    expect(screen.getByText('Stationsplein 1B, 1012AB Amsterdam')).toBeInTheDocument();
    expect(screen.queryByLabelText(a.postalCode)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.servicePointChange }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
