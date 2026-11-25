import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type {
  CarrierAccount,
  CarrierProduct,
  CarrierQuote,
  CreateLabelsResult,
  PickListShipping,
  ServicePoint,
} from '@weldsuite/app-api-client/schemas/shipping';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  products: [] as unknown[],
  productsLoading: false,
  productsError: null as Error | null,
  productsFetched: true,
  productCalls: [] as Array<{ carrierId: string | undefined; params: unknown; enabled: boolean | undefined }>,
  quote: { data: undefined, isFetching: false, isError: false } as { data: CarrierQuote | undefined; isFetching: boolean; isError: boolean },
  quoteCalls: [] as Array<{ carrierId: string | undefined; body: unknown }>,
  createAsync: vi.fn(),
  createPending: false,
  createError: null as unknown,
  servicePoints: [] as unknown[],
  push: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: vi.fn() } }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useCarrierProducts: (carrierId: string | undefined, params: unknown, enabled?: boolean) => {
    state.productCalls.push({ carrierId, params, enabled });
    const loaded = enabled !== false && !state.productsLoading && !state.productsError && state.productsFetched;
    return {
      data: loaded ? state.products : undefined,
      isLoading: state.productsLoading,
      isError: state.productsError !== null,
      isSuccess: loaded,
      error: state.productsError,
    };
  },
  useCarrierQuote: (carrierId: string | undefined, body: unknown) => {
    state.quoteCalls.push({ carrierId, body });
    return state.quote;
  },
  useCreateLabels: () => ({
    mutateAsync: state.createAsync,
    isPending: state.createPending,
    isError: state.createError !== null,
    error: state.createError,
  }),
  useServicePoints: (_carrierId: string | undefined, params: unknown) => ({
    data: params ? state.servicePoints : undefined,
    isFetching: false,
    isError: false,
    isSuccess: !!params,
    error: null,
  }),
  useParcelFile: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));

import { LabelsForm } from './labels-form';

const ts = en.weldstash.shipping;
const t = ts.labels;

function carrier(over: Partial<CarrierAccount> = {}): CarrierAccount {
  return {
    id: 'car_1',
    name: 'PostNL',
    code: 'postnl',
    carrierName: 'PostNL',
    contract: 'own',
    isDefault: false,
    isActive: true,
    accountNumber: null,
    settings: {},
    credentials: {},
    hasCredentials: true,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    ...over,
  };
}

function product(over: Partial<CarrierProduct> = {}): CarrierProduct {
  return { code: 'parcel', name: 'Parcel', servicePoint: false, multiCollo: false, mailbox: false, returns: false, options: [], ...over };
}

function shipping(over: Partial<PickListShipping> = {}): PickListShipping {
  return {
    pickListId: 'pl_1',
    status: 'packed',
    orderId: 'ord_1',
    orderNumber: 'SO-1',
    recipient: {
      name: 'Jan Jansen',
      company: null,
      street: 'Stationsstraat',
      houseNumber: '12',
      houseNumberSuffix: 'A',
      line1: 'Stationsstraat 12A',
      postalCode: '1012LG',
      city: 'Amsterdam',
      country: 'nl',
      email: 'jan@example.com',
    },
    sender: {},
    suggestedWeightGrams: 1250,
    customsRequired: false,
    customs: { content: 'sale_of_goods', invoiceNumber: null, currency: 'EUR', lines: [] },
    servicePoint: null,
    defaultCarrierId: 'car_1',
    parcels: [],
    ...over,
  };
}

const result: CreateLabelsResult = { pickListId: 'pl_1', parcels: [], returnParcel: null, warnings: [], credits: null };

const kiosk: ServicePoint = {
  id: 'sp_1',
  name: 'Kiosk Centraal',
  address: { street: 'Stationsplein', houseNumber: '1', postalCode: '1012AB', city: 'Amsterdam' },
  distanceMeters: 300,
  latitude: null,
  longitude: null,
  openingHours: [],
  locker: false,
  networkId: 'PNPNL-01',
};

function renderForm(props: { shipping?: PickListShipping; carriers?: CarrierAccount[] } = {}) {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  renderWithProviders(
    <LabelsForm
      pickListId="pl_1"
      shipping={props.shipping ?? shipping()}
      carriers={props.carriers ?? [carrier()]}
      onCreated={onCreated}
      onCancel={onCancel}
    />,
  );
  return { onCreated, onCancel };
}

const submit = () => screen.getByRole('button', { name: new RegExp(`^(${t.submit}|${t.submitting})`) });
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const field = (label: string) => screen.getByLabelText(new RegExp(`^${escapeRegExp(label)}`));
/** The weight field of a piece: its label is `Piece 1: Weight (kg)`. */
const weight = (piece = 1) => field(`${t.piece.replace('{number}', String(piece))}: ${t.weightKg}`);

function lastCreateInput() {
  return (state.createAsync.mock.calls.at(-1)?.[0] as { pickListId: string; data: Record<string, unknown> }).data;
}

beforeEach(() => {
  polyfillRadixSelect();
  state.products = [product()];
  state.productsLoading = false;
  state.productsError = null;
  state.productsFetched = true;
  state.productCalls = [];
  state.quote = { data: undefined, isFetching: false, isError: false };
  state.quoteCalls = [];
  state.createAsync.mockReset().mockResolvedValue(result);
  state.createPending = false;
  state.createError = null;
  state.servicePoints = [kiosk];
  state.push.mockReset();
  state.toastSuccess.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('LabelsForm without a carrier', () => {
  it('points to the carrier settings and remembers where to return to', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderForm({ carriers: [carrier({ isActive: false })] });
    expect(screen.getByText(t.noCarrierTitle)).toBeInTheDocument();
    expect(screen.getByText(t.noCarrierBody)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.noCarrierLink }));
    expect(state.push).toHaveBeenCalledWith('/settings/apps/weldstash');
    expect(window.sessionStorage.getItem('settings-return-url')).toBe(window.location.pathname);
    await user.click(screen.getByRole('button', { name: t.close }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('still opens the settings when session storage is blocked', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderForm({ carriers: [] });
    await user.click(screen.getByRole('button', { name: t.noCarrierLink }));
    expect(state.push).toHaveBeenCalledWith('/settings/apps/weldstash');
  });

  it('does not render the form fields', () => {
    renderForm({ carriers: [] });
    expect(screen.queryByRole('button', { name: t.submit })).not.toBeInTheDocument();
  });
});

describe('LabelsForm', () => {
  it('prefills the weight and recipient, and looks up the products for the destination', async () => {
    renderForm();
    expect(weight()).toHaveValue('1.25');
    expect(field(ts.address.name)).toHaveValue('Jan Jansen');
    expect(field(ts.address.street)).toHaveValue('Stationsstraat');
    expect(field(ts.address.postalCode)).toHaveValue('1012LG');
    await waitFor(() =>
      expect(state.productCalls.at(-1)).toEqual({ carrierId: 'car_1', params: { toCountry: 'NL', business: false }, enabled: true }),
    );
  });

  it('sends the pieces, recipient and product to the create-labels mutation', async () => {
    const user = userEvent.setup();
    const { onCreated } = renderForm();
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalledTimes(1));
    expect(state.createAsync.mock.calls[0]?.[0]).toMatchObject({ pickListId: 'pl_1' });
    expect(lastCreateInput()).toMatchObject({
      carrierId: 'car_1',
      product: 'parcel',
      pieces: [{ weightGrams: 1250 }],
      options: {},
      recipient: { name: 'Jan Jansen', street: 'Stationsstraat', houseNumber: '12', houseNumberSuffix: 'A', line1: 'Stationsstraat 12A', postalCode: '1012LG', city: 'Amsterdam', country: 'NL' },
    });
    expect(lastCreateInput()).not.toHaveProperty('customs');
    expect(lastCreateInput()).not.toHaveProperty('servicePoint');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    expect(state.toastSuccess).toHaveBeenCalledWith(t.created);
  });

  it('starts on the order\'s carrier, else the default one, else the first', async () => {
    const user = userEvent.setup();
    renderForm({
      shipping: shipping({ defaultCarrierId: null }),
      carriers: [carrier({ id: 'car_a', name: 'A' }), carrier({ id: 'car_b', name: 'B', isDefault: true })],
    });
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().carrierId).toBe('car_b');
  });

  it('falls back to the first active carrier', async () => {
    const user = userEvent.setup();
    renderForm({
      shipping: shipping({ defaultCarrierId: null }),
      carriers: [carrier({ id: 'car_off', isActive: false }), carrier({ id: 'car_a', name: 'A' }), carrier({ id: 'car_b', name: 'B' })],
    });
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().carrierId).toBe('car_a');
  });

  it('picks the carrier\'s default product, otherwise the first one', async () => {
    const user = userEvent.setup();
    state.products = [product({ code: 'parcel', name: 'Parcel' }), product({ code: 'express', name: 'Express' })];
    renderForm({ carriers: [carrier({ settings: { defaultProduct: 'express' } })] });
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().product).toBe('express');
  });

  it('lets the user choose another carrier', async () => {
    const user = userEvent.setup();
    renderForm({ carriers: [carrier(), carrier({ id: 'car_2', name: 'DHL', code: 'dhl_parcel_nl', contract: 'weldsuite' })] });
    await user.click(screen.getByRole('combobox', { name: new RegExp(`^${t.carrier}`) }));
    expect(await screen.findByRole('option', { name: `PostNL (${ts.contracts.own})` })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: `DHL (${ts.contracts.weldsuite})` }));
    await waitFor(() => expect(state.productCalls.at(-1)?.carrierId).toBe('car_2'));
    // WeldSuite's contract shows the price.
    expect(screen.getByText(t.price)).toBeInTheDocument();
  });

  it('asks the carrier for business products when the recipient has a company', async () => {
    renderForm({ shipping: shipping({ recipient: { ...shipping().recipient, company: 'Acme BV' } }) });
    await waitFor(() => expect(state.productCalls.at(-1)?.params).toEqual({ toCountry: 'NL', business: true }));
  });

  it('shows required and weight errors and does not send anything', async () => {
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.clear(weight());
    await user.clear(field(ts.address.name));
    await user.type(field(t.lengthCm), 'abc');
    await user.click(submit());
    expect(await screen.findByText(t.invalidWeight)).toBeInTheDocument();
    expect(screen.getByText(t.invalidNumber)).toBeInTheDocument();
    expect(screen.getAllByText(t.required).length).toBeGreaterThan(0);
    expect(state.createAsync).not.toHaveBeenCalled();
  });

  it('accepts a weight with a comma and sends the dimensions', async () => {
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.clear(weight());
    await user.type(weight(), '2,5');
    await user.type(field(t.lengthCm), '30');
    await user.type(field(t.widthCm), '20');
    await user.type(field(t.heightCm), '10');
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().pieces).toEqual([{ weightGrams: 2500, lengthCm: 30, widthCm: 20, heightCm: 10 }]);
  });

  it('shows the options the product lists and sends the ones that are checked', async () => {
    const user = userEvent.setup();
    state.products = [product({ returns: true, options: ['signature', 'insurance', 'ageCheck'] })];
    renderForm();
    await user.click(await screen.findByRole('checkbox', { name: ts.options.signature }));
    expect(screen.getByRole('checkbox', { name: ts.options.ageCheck })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: ts.options.mailbox })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: t.returnLabel }));
    await user.type(field(t.insuredValue), '150,50');
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput()).toMatchObject({ options: { signature: true, insuredValueCents: 15050 }, returnLabel: true });
  });

  it('shows no options section for a product without options', async () => {
    renderForm();
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByText(t.options)).not.toBeInTheDocument();
  });

  it('adds and removes pieces only for a multi-collo product', async () => {
    const user = userEvent.setup();
    state.products = [product({ multiCollo: true })];
    renderForm();
    expect(screen.queryByRole('button', { name: new RegExp(t.removePiece.replace('{number}', '\\d')) })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: t.addPiece }));
    await user.type(weight(2), '3');
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().pieces).toEqual([{ weightGrams: 1250 }, { weightGrams: 3000 }]);
    await user.click(screen.getByRole('button', { name: t.removePiece.replace('{number}', '2') }));
    expect(screen.queryByLabelText(new RegExp(`^${escapeRegExp(`${t.piece.replace('{number}', '2')}: ${t.weightKg}`)}`))).not.toBeInTheDocument();
  });

  it('hides the add-piece button for a single-parcel product', async () => {
    renderForm();
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByRole('button', { name: t.addPiece })).not.toBeInTheDocument();
  });

  it('cancels', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderForm();
    await user.click(screen.getByRole('button', { name: t.cancel }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('LabelsForm products', () => {
  it('disables the product and submit while the products load', () => {
    state.productsLoading = true;
    renderForm();
    expect(screen.getByText(t.productLoading)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it('shows why the products could not be loaded', () => {
    state.productsError = new Error('Carrier offline');
    renderForm();
    expect(screen.getByText('Carrier offline')).toBeInTheDocument();
  });

  it('falls back to the generic product error', () => {
    state.productsError = new Error('');
    renderForm();
    expect(screen.getByText(t.productLoadError)).toBeInTheDocument();
  });

  it('says when the carrier offers no product for the destination', () => {
    state.products = [];
    renderForm();
    expect(screen.getByText(t.productEmpty)).toBeInTheDocument();
  });

  it('does not look up products before the destination country is known', async () => {
    renderForm({ shipping: shipping({ recipient: { ...shipping().recipient, country: null } }) });
    await waitFor(() => expect(state.productCalls.at(-1)?.enabled).toBe(false));
  });
});

describe('LabelsForm service point', () => {
  beforeEach(() => {
    state.products = [product({ servicePoint: true })];
  });

  it('requires a service point when the product delivers to one', async () => {
    const user = userEvent.setup();
    renderForm();
    expect(await screen.findByText(t.servicePointHint)).toBeInTheDocument();
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(t.servicePointRequired);
    expect(state.createAsync).not.toHaveBeenCalled();
  });

  it('sends the chosen service point and clears the warning', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByRole('button', { name: new RegExp(t.servicePointSearch) }));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Kiosk Centraal/ }));
    await waitFor(() => expect(screen.queryByText(t.servicePointRequired)).not.toBeInTheDocument());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().servicePoint).toEqual({ id: 'sp_1', name: 'Kiosk Centraal', address: kiosk.address, networkId: 'PNPNL-01' });
  });

  it('starts from the service point the order already has, and lets the user change it', async () => {
    const user = userEvent.setup();
    renderForm({ shipping: shipping({ servicePoint: { id: 'sp_9', name: 'Shop Oost', address: { city: 'Utrecht' }, networkId: null } }) });
    expect(await screen.findByText('Shop Oost')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.servicePointChange }));
    expect(screen.queryByText('Shop Oost')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(t.servicePointSearch) })).toBeInTheDocument();
  });

  it('forgets the service point when the destination country changes', async () => {
    const user = userEvent.setup();
    renderForm({ shipping: shipping({ servicePoint: { id: 'sp_9', name: 'Shop Oost', address: { city: 'Utrecht' }, networkId: null } }) });
    expect(await screen.findByText('Shop Oost')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: new RegExp(ts.address.country) }));
    await user.click(await screen.findByRole('option', { name: /Belgium/ }));
    await waitFor(() => expect(screen.queryByText('Shop Oost')).not.toBeInTheDocument());
  });
});

describe('LabelsForm price on WeldSuite\'s contract', () => {
  const weldsuite = [carrier({ contract: 'weldsuite' })];

  it('shows no price row on the user\'s own contract', () => {
    renderForm();
    expect(screen.queryByText(t.price)).not.toBeInTheDocument();
    expect(state.quoteCalls.at(-1)?.carrierId).toBeUndefined();
  });

  it('requests a quote for the current pieces and shows the price in credits', async () => {
    state.quote = { data: { contract: 'weldsuite', credits: 3.5, lines: [] }, isFetching: false, isError: false };
    renderForm({ carriers: weldsuite });
    expect(screen.getByText(t.price)).toBeInTheDocument();
    expect(screen.getByText(t.priceHint)).toBeInTheDocument();
    expect(screen.getByText(t.priceCredits.replace('{credits}', new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(3.5)))).toBeInTheDocument();
    await waitFor(() =>
      expect(state.quoteCalls.at(-1)).toMatchObject({ carrierId: 'car_1', body: { product: 'parcel', toCountry: 'NL', pieces: [{ weightGrams: 1250 }] } }),
    );
  });

  it('shows that the price is being calculated', () => {
    state.quote = { data: undefined, isFetching: true, isError: false };
    renderForm({ carriers: weldsuite });
    expect(screen.getByText(t.priceLoading)).toBeInTheDocument();
  });

  it('says when the price could not be calculated', () => {
    state.quote = { data: undefined, isFetching: false, isError: true };
    renderForm({ carriers: weldsuite });
    expect(screen.getByText(t.priceUnavailable)).toBeInTheDocument();
  });

  it('shows a dash while there is no price yet', () => {
    renderForm({ carriers: weldsuite });
    expect(within(screen.getByText(t.price).closest('div')?.parentElement as HTMLElement).getByText('—')).toBeInTheDocument();
  });
});

describe('LabelsForm customs', () => {
  const customsShipping = () =>
    shipping({
      customsRequired: true,
      recipient: { ...shipping().recipient, country: 'GB' },
      customs: {
        content: 'gift',
        invoiceNumber: 'INV-7',
        currency: 'GBP',
        lines: [{ description: 'Mug', quantity: 2, valueCents: 1250, weightGrams: 300, hsCode: '6912', originCountry: 'NL' }],
      },
    });

  it('is not shown inside the EU', async () => {
    renderForm();
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByText(t.customs)).not.toBeInTheDocument();
  });

  it('prefills the declaration and sends it with the labels', async () => {
    const user = userEvent.setup();
    renderForm({ shipping: customsShipping() });
    expect(screen.getByText(t.customsHint)).toBeInTheDocument();
    expect(field(t.invoiceNumber)).toHaveValue('INV-7');
    expect(field(t.currency)).toHaveValue('GBP');
    expect(field(t.lineDescription)).toHaveValue('Mug');
    expect(field(t.lineValue)).toHaveValue('12.50');
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(lastCreateInput().customs).toEqual({
      content: 'gift',
      invoiceNumber: 'INV-7',
      currency: 'GBP',
      lines: [{ description: 'Mug', quantity: 2, valueCents: 1250, weightGrams: 300, hsCode: '6912', originCountry: 'NL' }],
    });
  });

  it('checks the customs lines before sending', async () => {
    const user = userEvent.setup();
    renderForm({ shipping: customsShipping() });
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.clear(field(t.lineDescription));
    await user.clear(field(t.lineQuantity));
    await user.type(field(t.lineQuantity), '1.5');
    await user.clear(field(t.lineValue));
    await user.clear(field(t.currency));
    await user.click(submit());
    expect(await screen.findByText(t.invalidQuantity)).toBeInTheDocument();
    expect(screen.getAllByText(t.required).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(t.invalidNumber)).toBeInTheDocument();
    expect(state.createAsync).not.toHaveBeenCalled();
  });

  it('adds and removes customs lines', async () => {
    const user = userEvent.setup();
    renderForm({ shipping: customsShipping() });
    expect(screen.queryByRole('button', { name: t.removeLine.replace('{number}', '1') })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.addLine }));
    expect(screen.getAllByLabelText(new RegExp(`^${t.lineDescription}`))).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: t.removeLine.replace('{number}', '2') }));
    expect(screen.getAllByLabelText(new RegExp(`^${t.lineDescription}`))).toHaveLength(1);
  });
});

describe('LabelsForm submit state', () => {
  it('disables submit while the labels are being created', () => {
    state.createPending = true;
    renderForm();
    expect(screen.getByRole('button', { name: new RegExp(t.submitting) })).toBeDisabled();
  });

  it('shows the carrier\'s refusal under the form and keeps the form usable', async () => {
    const user = userEvent.setup();
    const error = new ApiError('rejected', 422, {
      error: { code: 'SHIPMENT_INVALID', message: 'rejected', details: { messages: ['Unknown postal code'] } },
    });
    state.createAsync.mockRejectedValueOnce(error);
    state.createError = error;
    const { onCreated } = renderForm();
    expect(screen.getByText(t.createFailed)).toBeInTheDocument();
    expect(screen.getByText(ts.errors.SHIPMENT_INVALID)).toBeInTheDocument();
    expect(screen.getByText('Unknown postal code')).toBeInTheDocument();
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    await waitFor(() => expect(state.createAsync).toHaveBeenCalled());
    expect(onCreated).not.toHaveBeenCalled();
    expect(state.toastSuccess).not.toHaveBeenCalled();
  });
});
