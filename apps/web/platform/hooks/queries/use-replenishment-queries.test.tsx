/**
 * WeldStash replenishment queries: every hook calls the right client method,
 * refreshes the right keys after a mutation, and the planning run is polled
 * only while it is running.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRuntimeConfig } from '@/lib/runtime-config';

const replenishment = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  getPlanDemand: vi.fn(),
  dismissPlan: vi.fn(),
  restorePlan: vi.fn(),
  upsertRule: vi.fn(),
  deleteRule: vi.fn(),
  listRuns: vi.fn(),
  startRun: vi.fn(),
  createPurchaseOrders: vi.fn(),
  listIncoming: vi.fn(),
  listImports: vi.fn(),
  createImport: vi.fn(),
  addImportRows: vi.fn(),
  completeImport: vi.fn(),
  deleteImport: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ replenishment }),
}));

import {
  RUN_POLL_MS,
  replenishmentKeys,
  useAddSalesHistoryRows,
  useCompleteSalesHistoryImport,
  useCreatePurchaseOrdersFromPlans,
  useCreateSalesHistoryImport,
  useDeleteReorderRule,
  useDeleteSalesHistoryImport,
  useDismissPlan,
  useIncomingStock,
  useInfinitePlans,
  usePlan,
  usePlanDemand,
  usePlanningRunStatus,
  usePlanningRuns,
  useReplenishmentSettings,
  useRestorePlan,
  useSalesHistoryImports,
  useStartPlanningRun,
  useUpdateReplenishmentSettings,
  useUpsertReorderRule,
} from './use-replenishment-queries';

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

const PLANS_KEY = ['weldstash', 'replenishment', 'plans'];
const RULES_KEY = ['weldstash', 'replenishment', 'rules'];
const RUNS_KEY = ['weldstash', 'replenishment', 'runs'];
const IMPORTS_KEY = ['weldstash', 'replenishment', 'imports'];
const SETTINGS_KEY = ['weldstash', 'replenishment', 'settings'];

const run = (status: 'running' | 'done' | 'failed') => ({ id: `run_${status}`, status });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setRuntimeConfig(null);
  vi.useRealTimers();
});

describe('replenishmentKeys', () => {
  it('nests every key under the replenishment root', () => {
    expect(replenishmentKeys.settings()).toEqual(SETTINGS_KEY);
    expect(replenishmentKeys.planList()).toEqual([...PLANS_KEY, 'list', {}]);
    expect(replenishmentKeys.planList({ limit: 5 })).toEqual([...PLANS_KEY, 'list', { limit: 5 }]);
    expect(replenishmentKeys.plan('p1')).toEqual([...PLANS_KEY, 'detail', 'p1']);
    expect(replenishmentKeys.demand('p1')).toEqual([...PLANS_KEY, 'demand', 'p1']);
    expect(replenishmentKeys.rules()).toEqual([...RULES_KEY, {}]);
    expect(replenishmentKeys.rules({ productId: 'p' })).toEqual([...RULES_KEY, { productId: 'p' }]);
    expect(replenishmentKeys.runs()).toEqual(RUNS_KEY);
    expect(replenishmentKeys.incoming()).toEqual(['weldstash', 'replenishment', 'incoming', {}]);
    expect(replenishmentKeys.incoming({ warehouseId: 'w' })).toEqual([
      'weldstash',
      'replenishment',
      'incoming',
      { warehouseId: 'w' },
    ]);
    expect(replenishmentKeys.imports()).toEqual(IMPORTS_KEY);
  });
});

describe('settings', () => {
  it('useReplenishmentSettings unwraps the settings', async () => {
    enableReplenishment();
    replenishment.getSettings.mockResolvedValue({ data: { id: 's1', runHourUtc: 3 } });
    const { wrapper, qc } = setup();
    const { result } = renderHook(() => useReplenishmentSettings(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ id: 's1', runHourUtc: 3 }));
    expect(qc.getQueryData(SETTINGS_KEY)).toEqual({ id: 's1', runHourUtc: 3 });
  });

  it('useUpdateReplenishmentSettings caches the saved settings and refreshes the runs', async () => {
    replenishment.updateSettings.mockResolvedValue({ data: { id: 's1', runHourUtc: 5 } });
    const { wrapper, qc, invalidate } = setup();
    const { result } = renderHook(() => useUpdateReplenishmentSettings(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ runHourUtc: 5 });
    });
    expect(replenishment.updateSettings).toHaveBeenCalledWith({ runHourUtc: 5 });
    expect(qc.getQueryData(SETTINGS_KEY)).toEqual({ id: 's1', runHourUtc: 5 });
    expect(invalidatedKeys(invalidate)).toEqual([RUNS_KEY]);
  });
});

describe('plans', () => {
  it('useInfinitePlans lists with the default page size and follows the cursor', async () => {
    enableReplenishment();
    replenishment.listPlans
      .mockResolvedValueOnce({ data: [{ id: 'p1' }], pagination: { hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [{ id: 'p2' }], pagination: { hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useInfinitePlans(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(replenishment.listPlans).toHaveBeenLastCalledWith({ limit: 100, cursor: undefined });
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(replenishment.listPlans).toHaveBeenLastCalledWith({ limit: 100, cursor: 'c1' });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('useInfinitePlans passes filters, has no next page without pagination, and can be disabled', async () => {
    enableReplenishment();
    replenishment.listPlans.mockResolvedValue({ data: [] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useInfinitePlans({ needsReorder: true, limit: 20 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(replenishment.listPlans).toHaveBeenCalledWith({ needsReorder: true, limit: 20, cursor: undefined });
    expect(result.current.hasNextPage).toBe(false);

    replenishment.listPlans.mockClear();
    const off = renderHook(() => useInfinitePlans({ limit: 20 }, false), { wrapper });
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(replenishment.listPlans).not.toHaveBeenCalled();
  });

  it('usePlan and usePlanDemand fetch by id and stay idle without one', async () => {
    enableReplenishment();
    replenishment.getPlan.mockResolvedValue({ data: { plan: { id: 'p1' } } });
    replenishment.getPlanDemand.mockResolvedValue({ data: { history: [], forecast: [] } });
    const { wrapper } = setup();
    const plan = renderHook(() => usePlan('p1'), { wrapper });
    const demand = renderHook(() => usePlanDemand('p1'), { wrapper });
    await waitFor(() => expect(plan.result.current.data).toEqual({ plan: { id: 'p1' } }));
    await waitFor(() => expect(demand.result.current.data).toEqual({ history: [], forecast: [] }));
    expect(replenishment.getPlan).toHaveBeenCalledWith('p1');
    expect(replenishment.getPlanDemand).toHaveBeenCalledWith('p1');

    replenishment.getPlan.mockClear();
    replenishment.getPlanDemand.mockClear();
    const noPlan = renderHook(() => usePlan(null), { wrapper });
    const noDemand = renderHook(() => usePlanDemand(null), { wrapper });
    expect(noPlan.result.current.fetchStatus).toBe('idle');
    expect(noDemand.result.current.fetchStatus).toBe('idle');
    expect(replenishment.getPlan).not.toHaveBeenCalled();
    expect(replenishment.getPlanDemand).not.toHaveBeenCalled();
  });

  it('useDismissPlan passes the snooze time and refreshes the plans', async () => {
    replenishment.dismissPlan.mockResolvedValue({ data: { id: 'p1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDismissPlan(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'p1', data: { until: '2026-12-01T00:00:00Z' } });
    });
    expect(replenishment.dismissPlan).toHaveBeenCalledWith('p1', { until: '2026-12-01T00:00:00Z' });
    await act(async () => {
      await result.current.mutateAsync({ id: 'p2' });
    });
    expect(replenishment.dismissPlan).toHaveBeenLastCalledWith('p2', undefined);
    expect(invalidatedKeys(invalidate)).toEqual([PLANS_KEY, PLANS_KEY]);
  });

  it('useRestorePlan restores by id and refreshes the plans', async () => {
    replenishment.restorePlan.mockResolvedValue({ data: { id: 'p1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useRestorePlan(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('p1');
    });
    expect(replenishment.restorePlan).toHaveBeenCalledWith('p1');
    expect(invalidatedKeys(invalidate)).toEqual([PLANS_KEY]);
  });
});

describe('rules', () => {
  it('useUpsertReorderRule saves the rule and refreshes plans and rules', async () => {
    replenishment.upsertRule.mockResolvedValue({ data: { id: 'r1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useUpsertReorderRule(), { wrapper });
    const rule = { productId: 'prod_1', warehouseId: 'wh_1', method: 'auto' as const };
    await act(async () => {
      await result.current.mutateAsync(rule);
    });
    expect(replenishment.upsertRule).toHaveBeenCalledWith(rule);
    expect(invalidatedKeys(invalidate)).toEqual([PLANS_KEY, RULES_KEY]);
  });

  it('useDeleteReorderRule deletes by id and refreshes plans and rules', async () => {
    replenishment.deleteRule.mockResolvedValue(undefined);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeleteReorderRule(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('r1');
    });
    expect(replenishment.deleteRule).toHaveBeenCalledWith('r1');
    expect(invalidatedKeys(invalidate)).toEqual([PLANS_KEY, RULES_KEY]);
  });
});

describe('planning runs', () => {
  it('usePlanningRuns asks for the latest 5 runs by default, or the given limit', async () => {
    enableReplenishment();
    replenishment.listRuns.mockResolvedValue({ data: [run('done')] });
    const { wrapper, qc } = setup();
    const { result } = renderHook(() => usePlanningRuns(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([run('done')]));
    expect(replenishment.listRuns).toHaveBeenCalledWith({ limit: 5 });
    expect(qc.getQueryData([...RUNS_KEY, 5])).toEqual([run('done')]);

    const other = renderHook(() => usePlanningRuns(2), { wrapper });
    await waitFor(() => expect(other.result.current.isSuccess).toBe(true));
    expect(replenishment.listRuns).toHaveBeenLastCalledWith({ limit: 2 });
  });

  it('usePlanningRuns stays idle when disabled', () => {
    enableReplenishment();
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlanningRuns(5, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(replenishment.listRuns).not.toHaveBeenCalled();
  });

  it('polls every RUN_POLL_MS while the newest run is running', async () => {
    enableReplenishment();
    expect(RUN_POLL_MS).toBe(2000);
    replenishment.listRuns.mockResolvedValue({ data: [run('running')] });
    const { wrapper } = setup();
    renderHook(() => usePlanningRuns(), { wrapper });
    await waitFor(() => expect(replenishment.listRuns).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replenishment.listRuns.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: RUN_POLL_MS * 2,
    });
  });

  it('does not poll when the newest run is done, or there is no run', async () => {
    enableReplenishment();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    replenishment.listRuns.mockResolvedValue({ data: [run('done')] });
    const { wrapper } = setup();
    renderHook(() => usePlanningRuns(), { wrapper });
    await waitFor(() => expect(replenishment.listRuns).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
    });
    expect(replenishment.listRuns).toHaveBeenCalledTimes(1);

    replenishment.listRuns.mockClear();
    replenishment.listRuns.mockResolvedValue({ data: [] });
    renderHook(() => usePlanningRuns(1), { wrapper: setup().wrapper });
    await waitFor(() => expect(replenishment.listRuns).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
    });
    expect(replenishment.listRuns).toHaveBeenCalledTimes(1);
  });
});

describe('usePlanningRunStatus', () => {
  it('has no run before the first answer', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlanningRunStatus(), { wrapper });
    expect(result.current.latest).toBeNull();
    expect(result.current.running).toBe(false);
  });

  it('reports the newest run and whether it is running', async () => {
    enableReplenishment();
    replenishment.listRuns.mockResolvedValue({ data: [run('running'), run('done')] });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePlanningRunStatus(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.latest).toEqual(run('running'));
    expect(result.current.isLoading).toBe(false);
    expect(invalidatedKeys(invalidate)).not.toContainEqual(PLANS_KEY);
  });

  it('reloads the plans once when a running run finishes, and not for a run that was never running', async () => {
    enableReplenishment();
    replenishment.listRuns.mockResolvedValue({ data: [run('done')] });
    const { wrapper, qc, invalidate } = setup();
    const { result } = renderHook(() => usePlanningRunStatus(), { wrapper });
    await waitFor(() => expect(result.current.latest).toEqual(run('done')));
    expect(invalidatedKeys(invalidate)).not.toContainEqual(PLANS_KEY);

    act(() => {
      qc.setQueryData([...RUNS_KEY, 5], [run('running')]);
    });
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(invalidatedKeys(invalidate)).not.toContainEqual(PLANS_KEY);

    act(() => {
      qc.setQueryData([...RUNS_KEY, 5], [run('done')]);
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(invalidatedKeys(invalidate).filter((key) => key === PLANS_KEY || JSON.stringify(key) === JSON.stringify(PLANS_KEY))).toHaveLength(1);
  });

  it('does nothing when disabled', () => {
    enableReplenishment();
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlanningRunStatus(false), { wrapper });
    expect(result.current.latest).toBeNull();
    expect(replenishment.listRuns).not.toHaveBeenCalled();
  });

  it('useStartPlanningRun starts a run and refreshes the runs', async () => {
    replenishment.startRun.mockResolvedValue({ data: run('running') });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useStartPlanningRun(), { wrapper });
    let started: unknown;
    await act(async () => {
      started = await result.current.mutateAsync();
    });
    expect(started).toEqual(run('running'));
    expect(replenishment.startRun).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([RUNS_KEY]);
  });
});

describe('purchase orders from plans', () => {
  it('creates the orders and refreshes the plans and the purchase orders', async () => {
    replenishment.createPurchaseOrders.mockResolvedValue({ data: { purchaseOrders: [], skipped: [] } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreatePurchaseOrdersFromPlans(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ planIds: ['p1'], quantities: { p1: 4 } });
    });
    expect(replenishment.createPurchaseOrders).toHaveBeenCalledWith({ planIds: ['p1'], quantities: { p1: 4 } });
    expect(invalidatedKeys(invalidate)).toEqual([PLANS_KEY, ['weldstash', 'purchasing', 'orders']]);
  });
});

describe('incoming stock', () => {
  it('useIncomingStock lists with the filters', async () => {
    enableReplenishment();
    replenishment.listIncoming.mockResolvedValue({ data: [{ productId: 'p1', quantity: 4 }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useIncomingStock({ warehouseId: 'wh_1' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ productId: 'p1', quantity: 4 }]));
    expect(replenishment.listIncoming).toHaveBeenCalledWith({ warehouseId: 'wh_1' });
  });

  it('useIncomingStock stays idle when disabled', () => {
    enableReplenishment();
    const { wrapper } = setup();
    const { result } = renderHook(() => useIncomingStock({}, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(replenishment.listIncoming).not.toHaveBeenCalled();
  });
});

describe('CSV imports', () => {
  it('useSalesHistoryImports lists the imports', async () => {
    enableReplenishment();
    replenishment.listImports.mockResolvedValue({ data: [{ id: 'i1' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSalesHistoryImports(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'i1' }]));
    expect(replenishment.listImports).toHaveBeenCalledTimes(1);
  });

  it('useCreateSalesHistoryImport sends the file name and refreshes the imports', async () => {
    replenishment.createImport.mockResolvedValue({ data: { id: 'i1' } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreateSalesHistoryImport(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('sales.csv');
    });
    expect(replenishment.createImport).toHaveBeenCalledWith({ fileName: 'sales.csv' });
    expect(invalidatedKeys(invalidate)).toEqual([IMPORTS_KEY]);
  });

  it('useAddSalesHistoryRows sends a chunk and refreshes nothing', async () => {
    replenishment.addImportRows.mockResolvedValue({ data: { imported: 1, skipped: 0, unmatchedSkus: [] } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useAddSalesHistoryRows(), { wrapper });
    const data = { rows: [{ date: '2026-01-05', sku: 'A-1', quantity: 3 }], startRow: 0 };
    let added: unknown;
    await act(async () => {
      added = await result.current.mutateAsync({ id: 'i1', data });
    });
    expect(added).toEqual({ imported: 1, skipped: 0, unmatchedSkus: [] });
    expect(replenishment.addImportRows).toHaveBeenCalledWith('i1', data);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('useCompleteSalesHistoryImport completes and refreshes the imports and the settings', async () => {
    replenishment.completeImport.mockResolvedValue({ data: { import: { id: 'i1' }, suggestedCutoverDate: null } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCompleteSalesHistoryImport(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('i1');
    });
    expect(replenishment.completeImport).toHaveBeenCalledWith('i1');
    expect(invalidatedKeys(invalidate)).toEqual([IMPORTS_KEY, SETTINGS_KEY]);
  });

  it('useDeleteSalesHistoryImport deletes by id and refreshes the imports', async () => {
    replenishment.deleteImport.mockResolvedValue(undefined);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeleteSalesHistoryImport(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('i1');
    });
    expect(replenishment.deleteImport).toHaveBeenCalledWith('i1');
    expect(invalidatedKeys(invalidate)).toEqual([IMPORTS_KEY]);
  });
});
