/**
 * WeldStash purchasing queries: which client method each hook calls, and
 * which query keys a mutation refreshes.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRuntimeConfig } from '@/lib/runtime-config';

const purchaseOrders = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listLines: vi.fn(),
  listReceipts: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  createLine: vi.fn(),
  updateLine: vi.fn(),
  deleteLine: vi.fn(),
  approve: vi.fn(),
  markOrdered: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  receive: vi.fn(),
  sendToOdoo: vi.fn(),
}));
const productSuppliers = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() }));
const rawClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ purchaseOrders, productSuppliers }),
  useAppApiClient: () => ({ getClient: async () => rawClient }),
}));

import {
  purchasingKeys,
  useApprovePurchaseOrder,
  useCancelPurchaseOrder,
  useClosePurchaseOrder,
  useCreateProductSupplier,
  useCreatePurchaseOrder,
  useCreatePurchaseOrderLine,
  useDeleteProductSupplier,
  useDeletePurchaseOrder,
  useDeletePurchaseOrderLine,
  useInfinitePurchaseOrders,
  useMarkPurchaseOrderOrdered,
  useProductSuppliers,
  useProductTracking,
  usePurchaseOrder,
  usePurchaseOrderLines,
  usePurchaseOrderReceipts,
  useReceivePurchaseOrder,
  useSendPurchaseOrderToOdoo,
  useUpdateProductSupplier,
  useUpdatePurchaseOrder,
  useUpdatePurchaseOrderLine,
  useWarehouseLocations,
} from './use-purchasing-queries';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper, invalidate };
}

function invalidatedKeys(spy: ReturnType<typeof setup>['invalidate']) {
  return spy.mock.calls.map(([filters]) => filters?.queryKey);
}

function enableReplenishment() {
  setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] });
}

const ORDERS_KEY = ['weldstash', 'purchasing', 'orders'];
const REPLENISHMENT_KEY = ['weldstash', 'replenishment'];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setRuntimeConfig(null);
});

describe('purchasingKeys', () => {
  it('nests every key under the purchasing root', () => {
    expect(purchasingKeys.orderList()).toEqual([...ORDERS_KEY, 'list', {}]);
    expect(purchasingKeys.orderList({ status: 'draft' })).toEqual([...ORDERS_KEY, 'list', { status: 'draft' }]);
    expect(purchasingKeys.order('po1')).toEqual([...ORDERS_KEY, 'detail', 'po1']);
    expect(purchasingKeys.lines('po1')).toEqual([...ORDERS_KEY, 'lines', 'po1']);
    expect(purchasingKeys.receipts('po1')).toEqual([...ORDERS_KEY, 'receipts', 'po1']);
    expect(purchasingKeys.productSuppliers()).toEqual(['weldstash', 'purchasing', 'product-suppliers', {}]);
    expect(purchasingKeys.productSuppliers({ productId: 'p' })).toEqual([
      'weldstash',
      'purchasing',
      'product-suppliers',
      { productId: 'p' },
    ]);
  });
});

describe('useWarehouseLocations', () => {
  it('fetches the locations of a warehouse, encoding the id', async () => {
    rawClient.get.mockResolvedValue({ data: [{ id: 'loc_1', code: 'A1', name: null }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWarehouseLocations('wh/1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rawClient.get).toHaveBeenCalledWith('/warehouse-locations?warehouseId=wh%2F1&limit=200');
    expect(result.current.data).toEqual([{ id: 'loc_1', code: 'A1', name: null }]);
  });

  it('stays idle without a warehouse or when disabled', () => {
    const { wrapper } = setup();
    const none = renderHook(() => useWarehouseLocations(null), { wrapper });
    const off = renderHook(() => useWarehouseLocations('wh_1', false), { wrapper });
    expect(none.result.current.fetchStatus).toBe('idle');
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(rawClient.get).not.toHaveBeenCalled();
  });
});

describe('useProductTracking', () => {
  it('loads each distinct product once and maps the tracking flags by id', async () => {
    rawClient.get.mockImplementation(async (path: string) =>
      path === '/products/p1'
        ? { data: { id: 'p1', trackLots: true, trackExpiry: null } }
        : { data: { id: 'p2' } },
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useProductTracking(['p1', 'p2', 'p1']), { wrapper });
    await waitFor(() => expect(Object.keys(result.current.tracking)).toHaveLength(2));
    expect(rawClient.get).toHaveBeenCalledTimes(2);
    expect(result.current.tracking).toEqual({
      p1: { id: 'p1', trackLots: true, trackExpiry: false },
      p2: { id: 'p2', trackLots: false, trackExpiry: false },
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('reports loading while products load and does nothing when disabled', async () => {
    rawClient.get.mockReturnValue(new Promise(() => undefined));
    const { wrapper } = setup();
    const loading = renderHook(() => useProductTracking(['p1']), { wrapper });
    await waitFor(() => expect(loading.result.current.isLoading).toBe(true));
    expect(loading.result.current.tracking).toEqual({});

    rawClient.get.mockClear();
    const off = renderHook(() => useProductTracking(['p9'], false), { wrapper: setup().wrapper });
    expect(off.result.current.isLoading).toBe(false);
    expect(rawClient.get).not.toHaveBeenCalled();
  });
});

describe('useInfinitePurchaseOrders', () => {
  it('lists with the default page size and follows the cursor while there are more', async () => {
    purchaseOrders.list
      .mockResolvedValueOnce({ data: [{ id: 'po1' }], pagination: { hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [{ id: 'po2' }], pagination: { hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useInfinitePurchaseOrders(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(purchaseOrders.list).toHaveBeenLastCalledWith({ limit: 50, cursor: undefined });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(purchaseOrders.list).toHaveBeenLastCalledWith({ limit: 50, cursor: 'c1' });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('passes filters through and has no next page without pagination info or a cursor', async () => {
    purchaseOrders.list.mockResolvedValue({ data: [] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useInfinitePurchaseOrders({ limit: 10, status: 'draft' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(purchaseOrders.list).toHaveBeenCalledWith({ limit: 10, status: 'draft', cursor: undefined });
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('purchase order reads', () => {
  it('usePurchaseOrder gets the order by id and unwraps data', async () => {
    purchaseOrders.get.mockResolvedValue({ data: { id: 'po1' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePurchaseOrder('po1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ id: 'po1' }));
    expect(purchaseOrders.get).toHaveBeenCalledWith('po1');
  });

  it('usePurchaseOrder stays idle without an id', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => usePurchaseOrder(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(purchaseOrders.get).not.toHaveBeenCalled();
  });

  it('usePurchaseOrderLines lists the lines by id and stays idle without one', async () => {
    purchaseOrders.listLines.mockResolvedValue({ data: [{ id: 'it1' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePurchaseOrderLines('po1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'it1' }]));
    expect(purchaseOrders.listLines).toHaveBeenCalledWith('po1');

    purchaseOrders.listLines.mockClear();
    const idle = renderHook(() => usePurchaseOrderLines(''), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    expect(purchaseOrders.listLines).not.toHaveBeenCalled();
  });

  it('usePurchaseOrderReceipts loads on Kubernetes editions and stays idle without an id', async () => {
    enableReplenishment();
    purchaseOrders.listReceipts.mockResolvedValue({ data: [{ id: 'rc1' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePurchaseOrderReceipts('po1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'rc1' }]));
    expect(purchaseOrders.listReceipts).toHaveBeenCalledWith('po1');

    purchaseOrders.listReceipts.mockClear();
    const idle = renderHook(() => usePurchaseOrderReceipts(''), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    expect(purchaseOrders.listReceipts).not.toHaveBeenCalled();
  });
});

describe('purchase order mutations', () => {
  it('useCreatePurchaseOrder creates and refreshes the orders', async () => {
    purchaseOrders.create.mockResolvedValue({ data: { id: 'po9' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreatePurchaseOrder(), { wrapper });
    let created: unknown;
    await act(async () => {
      created = await result.current.mutateAsync({ supplierId: 'sup_1' });
    });
    expect(created).toEqual({ id: 'po9' });
    expect(purchaseOrders.create).toHaveBeenCalledWith({ supplierId: 'sup_1' });
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('useUpdatePurchaseOrder sends the id and data, then refreshes the orders', async () => {
    purchaseOrders.update.mockResolvedValue({ data: { id: 'po1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useUpdatePurchaseOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'po1', data: { internalNotes: 'x' } });
    });
    expect(purchaseOrders.update).toHaveBeenCalledWith('po1', { internalNotes: 'x' });
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('useDeletePurchaseOrder deletes by id, then refreshes the orders', async () => {
    purchaseOrders.delete.mockResolvedValue(undefined);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeletePurchaseOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('po1');
    });
    expect(purchaseOrders.delete).toHaveBeenCalledWith('po1');
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('does not refresh anything when the request fails', async () => {
    purchaseOrders.delete.mockRejectedValue(new Error('nope'));
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeletePurchaseOrder(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync('po1')).rejects.toThrow('nope');
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('line mutations', () => {
  it('useCreatePurchaseOrderLine posts to the order it was created for', async () => {
    purchaseOrders.createLine.mockResolvedValue({ data: { id: 'it1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreatePurchaseOrderLine('po1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ name: 'Widget', unitPrice: 2 });
    });
    expect(purchaseOrders.createLine).toHaveBeenCalledWith('po1', { name: 'Widget', unitPrice: 2 });
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('useUpdatePurchaseOrderLine patches one line of the order', async () => {
    purchaseOrders.updateLine.mockResolvedValue({ data: { id: 'it1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useUpdatePurchaseOrderLine('po1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ itemId: 'it1', data: { quantityOrdered: 5 } });
    });
    expect(purchaseOrders.updateLine).toHaveBeenCalledWith('po1', 'it1', { quantityOrdered: 5 });
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('useDeletePurchaseOrderLine deletes one line of the order', async () => {
    purchaseOrders.deleteLine.mockResolvedValue(undefined);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeletePurchaseOrderLine('po1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('it1');
    });
    expect(purchaseOrders.deleteLine).toHaveBeenCalledWith('po1', 'it1');
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });
});

describe('status actions', () => {
  it('useApprovePurchaseOrder approves and refreshes the orders', async () => {
    purchaseOrders.approve.mockResolvedValue({ data: { id: 'po1', status: 'approved' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useApprovePurchaseOrder(), { wrapper });
    let order: unknown;
    await act(async () => {
      order = await result.current.mutateAsync('po1');
    });
    expect(order).toEqual({ id: 'po1', status: 'approved' });
    expect(purchaseOrders.approve).toHaveBeenCalledWith('po1');
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('useMarkPurchaseOrderOrdered passes the optional dates', async () => {
    purchaseOrders.markOrdered.mockResolvedValue({ data: { id: 'po1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useMarkPurchaseOrderOrdered(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'po1', data: { orderDate: '2026-11-01' } });
    });
    expect(purchaseOrders.markOrdered).toHaveBeenCalledWith('po1', { orderDate: '2026-11-01' });
    await act(async () => {
      await result.current.mutateAsync({ id: 'po2' });
    });
    expect(purchaseOrders.markOrdered).toHaveBeenLastCalledWith('po2', undefined);
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY, ORDERS_KEY]);
  });

  it('useCancelPurchaseOrder also refreshes replenishment, which counted the order as incoming', async () => {
    purchaseOrders.cancel.mockResolvedValue({ data: { id: 'po1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCancelPurchaseOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('po1');
    });
    expect(purchaseOrders.cancel).toHaveBeenCalledWith('po1');
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY, REPLENISHMENT_KEY]);
  });

  it('useClosePurchaseOrder closes and refreshes the orders', async () => {
    purchaseOrders.close.mockResolvedValue({ data: { id: 'po1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useClosePurchaseOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('po1');
    });
    expect(purchaseOrders.close).toHaveBeenCalledWith('po1');
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });

  it('useReceivePurchaseOrder refreshes orders, stock, movements and replenishment', async () => {
    purchaseOrders.receive.mockResolvedValue({ data: { receipt: { id: 'rc1' } } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReceivePurchaseOrder(), { wrapper });
    const data = { idempotencyKey: 'k1', lines: [{ itemId: 'it1', quantity: 3 }] };
    await act(async () => {
      await result.current.mutateAsync({ id: 'po1', data });
    });
    expect(purchaseOrders.receive).toHaveBeenCalledWith('po1', data);
    expect(invalidatedKeys(invalidate)).toEqual([
      ORDERS_KEY,
      ['weldstash', 'stock'],
      ['weldstash', 'movements'],
      REPLENISHMENT_KEY,
    ]);
  });

  it('useSendPurchaseOrderToOdoo sends the order and refreshes the orders', async () => {
    purchaseOrders.sendToOdoo.mockResolvedValue({ data: { odoo: { id: 7, name: 'P00007' } } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSendPurchaseOrderToOdoo(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('po1');
    });
    expect(purchaseOrders.sendToOdoo).toHaveBeenCalledWith('po1');
    expect(invalidatedKeys(invalidate)).toEqual([ORDERS_KEY]);
  });
});

describe('product suppliers', () => {
  it('useProductSuppliers lists with the filters on Kubernetes editions', async () => {
    enableReplenishment();
    productSuppliers.list.mockResolvedValue({ data: [{ id: 'ps1' }] });
    const { wrapper, qc } = setup();
    const { result } = renderHook(() => useProductSuppliers({ productId: 'p1' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'ps1' }]));
    expect(productSuppliers.list).toHaveBeenCalledWith({ productId: 'p1' });
    expect(qc.getQueryData(purchasingKeys.productSuppliers({ productId: 'p1' }))).toEqual([{ id: 'ps1' }]);
  });

  it('useProductSuppliers stays idle when the caller disables it', () => {
    enableReplenishment();
    const { wrapper } = setup();
    const { result } = renderHook(() => useProductSuppliers({ productId: 'p1' }, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(productSuppliers.list).not.toHaveBeenCalled();
  });

  const SUPPLIER_KEYS = [['weldstash', 'purchasing', 'product-suppliers'], REPLENISHMENT_KEY];

  it('useCreateProductSupplier creates, then refreshes suppliers and plans', async () => {
    productSuppliers.create.mockResolvedValue({ data: { id: 'ps1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreateProductSupplier(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ productId: 'p1', supplierId: 'sup_1' });
    });
    expect(productSuppliers.create).toHaveBeenCalledWith({ productId: 'p1', supplierId: 'sup_1' });
    expect(invalidatedKeys(invalidate)).toEqual(SUPPLIER_KEYS);
  });

  it('useUpdateProductSupplier updates by id, then refreshes suppliers and plans', async () => {
    productSuppliers.update.mockResolvedValue({ data: { id: 'ps1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useUpdateProductSupplier(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ps1', data: { isPreferred: true } });
    });
    expect(productSuppliers.update).toHaveBeenCalledWith('ps1', { isPreferred: true });
    expect(invalidatedKeys(invalidate)).toEqual(SUPPLIER_KEYS);
  });

  it('useDeleteProductSupplier deletes by id, then refreshes suppliers and plans', async () => {
    productSuppliers.delete.mockResolvedValue(undefined);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeleteProductSupplier(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('ps1');
    });
    expect(productSuppliers.delete).toHaveBeenCalledWith('ps1');
    expect(invalidatedKeys(invalidate)).toEqual(SUPPLIER_KEYS);
  });
});
