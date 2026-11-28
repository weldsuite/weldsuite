import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

import {
  isTimeBillingAvailable,
  timeBillingKeys,
  useInvoiceFromTime,
  useProjectInvoicing,
  useUnbilledTime,
} from './use-weldbooks-time-billing-queries';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}

const touched = (invalidate: { mock: { calls: unknown[][] } }) =>
  invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  setRuntimeConfig(RUST);
});
afterEach(() => setRuntimeConfig(null));

describe('time billing on Global', () => {
  it('is not offered, and asks nothing, where the edition lacks it', () => {
    setRuntimeConfig(null);
    expect(isTimeBillingAvailable()).toBe(false);
    const { wrapper } = setup();
    const unbilled = renderHook(() => useUnbilledTime(), { wrapper });
    const finance = renderHook(() => useProjectInvoicing('prj_1'), { wrapper });
    expect(unbilled.result.current.fetchStatus).toBe('idle');
    expect(finance.result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('the unbilled time', () => {
  it('asks for the customers with hours, filtered by project or customer and date when given', async () => {
    api.get.mockResolvedValue({ data: [] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnbilledTime({ projectId: 'prj_1', to: '2026-11-30' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/accounting-time/unbilled?projectId=prj_1&to=2026-11-30');
  });

  it('asks a project for its invoiced, draft and unbilled amounts', async () => {
    api.get.mockResolvedValue({ data: { projectId: 'prj_1', invoiced: [], draft: [] } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectInvoicing('prj_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/accounting-projects/prj_1/finance');
  });
});

describe('invoicing hours', () => {
  it('posts the entries with the grouping and, to add to a draft, the invoice', async () => {
    api.post.mockResolvedValue({ data: { id: 'inv_1', items: [] } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useInvoiceFromTime('prt_1'), { wrapper });
    const made = await result.current.mutateAsync({ timeEntryIds: ['te_1', 'te_2'], grouping: 'person', invoiceId: 'inv_1' });
    expect(api.post).toHaveBeenCalledWith('/invoices/from-time', { timeEntryIds: ['te_1', 'te_2'], grouping: 'person', invoiceId: 'inv_1' });
    expect(made.id).toBe('inv_1');
  });

  it('refreshes what an invoiced hour touches: the lists, the invoices, the contact, To process, the time entries and the project figures', async () => {
    api.post.mockResolvedValue({ data: { id: 'inv_1' } });
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useInvoiceFromTime('prt_1'), { wrapper });
    await result.current.mutateAsync({ timeEntryIds: ['te_1'], grouping: 'project' });
    const keys = touched(invalidate);
    expect(keys).toContain(JSON.stringify(timeBillingKeys.all));
    expect(keys).toContain(JSON.stringify(['accounting', 'invoices']));
    expect(keys).toContain(JSON.stringify(['accounting', 'customers', 'detail', 'prt_1']));
    expect(keys).toContain(JSON.stringify(['accounting', 'todo']));
    expect(keys).toContain(JSON.stringify(['accounting', 'dashboard']));
    expect(keys).toContain(JSON.stringify(['projects']));
  });

  it('refreshes the unbilled list when the server refuses, because an entry was invoiced in the meantime', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('Already invoiced'), { status: 409 }));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useInvoiceFromTime('prt_1'), { wrapper });
    await expect(result.current.mutateAsync({ timeEntryIds: ['te_1'], grouping: 'project' })).rejects.toThrow('Already invoiced');
    expect(touched(invalidate)).toContain(JSON.stringify(timeBillingKeys.all));
    expect(touched(invalidate)).not.toContain(JSON.stringify(['accounting', 'invoices']));
  });
});
