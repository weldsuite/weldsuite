import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  available: true,
  api: {
    getCatalog: vi.fn(),
    listCarriers: vi.fn(),
    createCarrier: vi.fn(),
    updateCarrier: vi.fn(),
    deleteCarrier: vi.fn(),
    testCarrier: vi.fn(),
    listProducts: vi.fn(),
    listServicePoints: vi.fn(),
    quote: vi.fn(),
    getPickListShipping: vi.fn(),
    createLabels: vi.fn(),
    voidLabels: vi.fn(),
    listParcels: vi.fn(),
    getParcel: vi.fn(),
    refreshTracking: vi.fn(),
    createReturnLabel: vi.fn(),
    getLabelBlob: vi.fn(),
    getCustomsDocumentBlob: vi.fn(),
  },
}));

vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ shipping: mocks.api }) }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => mocks.available }));

import {
  shippingKeys,
  useCarrierCatalog,
  useCarrierProducts,
  useCarrierQuote,
  useCarriers,
  useCreateCarrier,
  useCreateLabels,
  useCreateReturnLabel,
  useDeleteCarrier,
  useInfiniteParcels,
  useParcel,
  useParcelFile,
  usePickListShipping,
  useRefreshTracking,
  useServicePoints,
  useTestCarrier,
  useUpdateCarrier,
  useVoidLabels,
  type ParcelFileRequest,
} from './use-shipping-queries';

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mocks.available = true;
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe('query hooks', () => {
  it('useCarrierCatalog and useCarriers unwrap data', async () => {
    mocks.api.getCatalog.mockResolvedValue({ data: [{ code: 'postnl' }] });
    mocks.api.listCarriers.mockResolvedValue({ data: [{ id: 'car_1' }] });
    const catalog = renderHook(() => useCarrierCatalog(), { wrapper });
    const carriers = renderHook(() => useCarriers(), { wrapper });
    await waitFor(() => expect(catalog.result.current.data).toEqual([{ code: 'postnl' }]));
    await waitFor(() => expect(carriers.result.current.data).toEqual([{ id: 'car_1' }]));
  });

  it('stays idle when the edition has no shipping or the caller disables it', () => {
    mocks.available = false;
    const a = renderHook(() => useCarriers(), { wrapper });
    const b = renderHook(() => useCarrierCatalog(), { wrapper });
    const c = renderHook(() => useParcel('par_1'), { wrapper });
    mocks.available = true;
    const d = renderHook(() => useCarriers(false), { wrapper });
    expect(a.result.current.fetchStatus).toBe('idle');
    expect(b.result.current.fetchStatus).toBe('idle');
    expect(c.result.current.fetchStatus).toBe('idle');
    expect(d.result.current.fetchStatus).toBe('idle');
    expect(mocks.api.listCarriers).not.toHaveBeenCalled();
  });

  it('useCarrierProducts needs a carrier id', async () => {
    mocks.api.listProducts.mockResolvedValue({ data: [{ code: 'std' }] });
    const idle = renderHook(() => useCarrierProducts(undefined, {}), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    const { result } = renderHook(() => useCarrierProducts('car_1', { toCountry: 'NL' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ code: 'std' }]));
    expect(mocks.api.listProducts).toHaveBeenCalledWith('car_1', { toCountry: 'NL' });
  });

  it('useServicePoints waits for search params', async () => {
    mocks.api.listServicePoints.mockResolvedValue({ data: [{ id: 'sp_1' }] });
    const idle = renderHook(() => useServicePoints('car_1', null), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    const noCarrier = renderHook(() => useServicePoints(undefined, null), { wrapper });
    expect(noCarrier.result.current.fetchStatus).toBe('idle');
    const params = { country: 'NL', postalCode: '1012LG' };
    const { result } = renderHook(() => useServicePoints('car_1', params), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'sp_1' }]));
    expect(mocks.api.listServicePoints).toHaveBeenCalledWith('car_1', params);
  });

  it('useCarrierQuote waits for a body', async () => {
    mocks.api.quote.mockResolvedValue({ data: { contract: 'weldsuite', credits: 3, lines: [] } });
    const idle = renderHook(() => useCarrierQuote('car_1', null), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    const noCarrier = renderHook(() => useCarrierQuote(undefined, null), { wrapper });
    expect(noCarrier.result.current.fetchStatus).toBe('idle');
    const body = { toCountry: 'NL', pieces: [{ weightGrams: 500 }] };
    const { result } = renderHook(() => useCarrierQuote('car_1', body), { wrapper });
    await waitFor(() => expect(result.current.data?.credits).toBe(3));
    expect(mocks.api.quote).toHaveBeenCalledWith('car_1', body);
  });

  it('usePickListShipping and useParcel need an id', async () => {
    mocks.api.getPickListShipping.mockResolvedValue({ data: { pickListId: 'pl_1' } });
    mocks.api.getParcel.mockResolvedValue({ data: { id: 'par_1' } });
    expect(renderHook(() => usePickListShipping(''), { wrapper }).result.current.fetchStatus).toBe('idle');
    expect(renderHook(() => useParcel(''), { wrapper }).result.current.fetchStatus).toBe('idle');
    const ship = renderHook(() => usePickListShipping('pl_1'), { wrapper });
    const parcel = renderHook(() => useParcel('par_1'), { wrapper });
    await waitFor(() => expect(ship.result.current.data).toEqual({ pickListId: 'pl_1' }));
    await waitFor(() => expect(parcel.result.current.data).toEqual({ id: 'par_1' }));
  });

  it('useInfiniteParcels pages by cursor while the server says there is more', async () => {
    mocks.api.listParcels
      .mockResolvedValueOnce({ data: [{ id: 'a' }], pagination: { hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [{ id: 'b' }], pagination: { hasMore: false, cursor: null } });
    const { result } = renderHook(() => useInfiniteParcels({ status: 'shipped' }), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(mocks.api.listParcels).toHaveBeenLastCalledWith({ status: 'shipped', cursor: undefined });
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(mocks.api.listParcels).toHaveBeenLastCalledWith({ status: 'shipped', cursor: 'c1' });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('useInfiniteParcels has no next page without pagination info', async () => {
    mocks.api.listParcels.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useInfiniteParcels({}), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('useInfiniteParcels has no next page when hasMore comes without a cursor', async () => {
    mocks.api.listParcels.mockResolvedValue({ data: [], pagination: { hasMore: true } });
    const { result } = renderHook(() => useInfiniteParcels({}), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('mutation hooks', () => {
  it('carrier mutations call the client and invalidate the carriers', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    mocks.api.createCarrier.mockResolvedValue({ data: { id: 'car_1' } });
    mocks.api.updateCarrier.mockResolvedValue({ data: { id: 'car_1' } });
    mocks.api.deleteCarrier.mockResolvedValue(undefined);

    const create = renderHook(() => useCreateCarrier(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({ code: 'postnl', contract: 'own' });
    });
    expect(mocks.api.createCarrier).toHaveBeenCalledWith({ code: 'postnl', contract: 'own' });

    const update = renderHook(() => useUpdateCarrier(), { wrapper });
    await act(async () => {
      await update.result.current.mutateAsync({ id: 'car_1', data: { isDefault: true } });
    });
    expect(mocks.api.updateCarrier).toHaveBeenCalledWith('car_1', { isDefault: true });

    const del = renderHook(() => useDeleteCarrier(), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync('car_1');
    });
    expect(mocks.api.deleteCarrier).toHaveBeenCalledWith('car_1');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith({ queryKey: shippingKeys.carriers() });
  });

  it('useTestCarrier returns the test result', async () => {
    mocks.api.testCarrier.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useTestCarrier(), { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync('car_1');
    });
    expect(out).toEqual({ ok: true });
  });

  it('createLabels and voidLabels refresh the pick list, its shipping and the parcels', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    mocks.api.createLabels.mockResolvedValue({ data: { pickListId: 'pl_1' } });
    mocks.api.voidLabels.mockResolvedValue({ data: { voided: 1 } });
    const create = renderHook(() => useCreateLabels(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({ pickListId: 'pl_1', data: { pieces: [{ weightGrams: 500 }] } });
    });
    expect(mocks.api.createLabels).toHaveBeenCalledWith('pl_1', { pieces: [{ weightGrams: 500 }] });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenCalledWith({ queryKey: shippingKeys.pickListShipping('pl_1') });
    expect(spy).toHaveBeenCalledWith({ queryKey: shippingKeys.parcels() });

    spy.mockClear();
    const voided = renderHook(() => useVoidLabels(), { wrapper });
    await act(async () => {
      await voided.result.current.mutateAsync('pl_1');
    });
    expect(mocks.api.voidLabels).toHaveBeenCalledWith('pl_1');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('refreshTracking and createReturnLabel invalidate the parcels', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    mocks.api.refreshTracking.mockResolvedValue({ data: { id: 'par_1' } });
    mocks.api.createReturnLabel.mockResolvedValue({ data: { id: 'par_2' } });
    const refresh = renderHook(() => useRefreshTracking(), { wrapper });
    await act(async () => {
      await refresh.result.current.mutateAsync('par_1');
    });
    const ret = renderHook(() => useCreateReturnLabel(), { wrapper });
    await act(async () => {
      await ret.result.current.mutateAsync({ id: 'par_1', data: { weightGrams: 400 } });
    });
    expect(mocks.api.createReturnLabel).toHaveBeenCalledWith('par_1', { weightGrams: 400 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: shippingKeys.parcels() });
  });
});

describe('useParcelFile', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:file');
  const revokeObjectURL = vi.fn();
  let open: ReturnType<typeof vi.spyOn>;
  let click: ReturnType<typeof vi.spyOn>;
  let anchors: HTMLAnchorElement[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    anchors = [];
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    mocks.api.getLabelBlob.mockResolvedValue(new Blob(['pdf']));
    mocks.api.getCustomsDocumentBlob.mockResolvedValue(new Blob(['customs']));
  });

  afterEach(() => {
    vi.useRealTimers();
    open.mockRestore();
    click.mockRestore();
  });

  async function run(request: ParcelFileRequest) {
    const { result } = renderHook(() => useParcelFile(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(request);
    });
  }

  it('opens a label PDF in a tab and releases the URL after a minute', async () => {
    await run({ id: 'par_1', kind: 'label', action: 'open' });
    expect(open).toHaveBeenCalledWith('blob:file', '_blank');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file');
  });

  it('releases the URL at once when the tab was blocked', async () => {
    open.mockReturnValue(null);
    await run({ id: 'par_1', kind: 'label', action: 'open' });
    vi.advanceTimersByTime(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file');
  });

  it('downloads a label PDF under a name made from the kind and id', async () => {
    await run({ id: 'par_1', kind: 'label', action: 'download', format: 'pdf' });
    expect(open).not.toHaveBeenCalled();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.download).toBe('label-par_1.pdf');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file');
  });

  it('always downloads a ZPL label, as text', async () => {
    await run({ id: 'par_1', kind: 'label', action: 'open', format: 'zpl', fileName: 'order-12' });
    expect(open).not.toHaveBeenCalled();
    expect(anchors[0]!.download).toBe('order-12.zpl');
    expect(createObjectURL.mock.calls[0]![0].type).toBe('text/plain');
  });

  it('fetches the customs document for kind customs', async () => {
    await run({ id: 'par_1', kind: 'customs', action: 'download', format: 'zpl' });
    expect(mocks.api.getCustomsDocumentBlob).toHaveBeenCalledWith('par_1');
    expect(mocks.api.getLabelBlob).not.toHaveBeenCalled();
    expect(anchors[0]!.download).toBe('customs-par_1.pdf');
  });
});

describe('shippingKeys', () => {
  it('nests every key under the carriers or parcels root', () => {
    expect(shippingKeys.parcel('x')).toEqual([...shippingKeys.parcels(), 'detail', 'x']);
    expect(shippingKeys.parcelList({ status: 'shipped' }).slice(0, 3)).toEqual([...shippingKeys.parcels(), 'list']);
    expect(shippingKeys.products('c', {}).slice(0, -2)).toEqual([...shippingKeys.carriers(), 'c']);
  });
});
