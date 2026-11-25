import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ meAttendance: vi.fn() }));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ weldhr: { meAttendance: mocks.meAttendance } }),
}));

import { useMyAttendanceItem, weldhrKeys } from './use-weldhr-queries';

/** The Schedule's default period, and an older one ("Last 3 months"). */
const AROUND = { from: '2026-10-25', to: '2026-12-07' };
const OLDER = { from: '2026-08-24', to: '2026-11-23' };
const RANGES = [AROUND, OLDER];

const page = (...shiftIds: string[]) => ({ data: { shifts: shiftIds.map((id) => ({ id })), records: [] } });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  mocks.meAttendance.mockReset();
});

describe('useMyAttendanceItem', () => {
  it('takes a shift from the period the Schedule has loaded', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.me('attendance', AROUND), page('hrshf_1'));
    const { result } = renderHook(() => useMyAttendanceItem('shifts', 'hrshf_1', RANGES), { wrapper });
    expect(result.current.item).toEqual({ id: 'hrshf_1' });
    expect(mocks.meAttendance).not.toHaveBeenCalled();
  });

  it('loads the Schedule periods for a shift no loaded period has (an old shift, a copied link)', async () => {
    mocks.meAttendance.mockImplementation(async (range: { from: string }) => (range.from === OLDER.from ? page('hrshf_old') : page()));
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.me('attendance', AROUND), page('hrshf_1'));
    const { result } = renderHook(() => useMyAttendanceItem('shifts', 'hrshf_old', RANGES), { wrapper });

    expect(result.current.item).toBeUndefined();
    await waitFor(() => expect(result.current.item).toEqual({ id: 'hrshf_old' }));
    expect(mocks.meAttendance).toHaveBeenCalledWith(OLDER);
  });

  it('says not found once no period has it', async () => {
    mocks.meAttendance.mockResolvedValue(page('hrshf_1'));
    const { wrapper } = setup();
    const { result } = renderHook(() => useMyAttendanceItem('shifts', 'hrshf_gone', RANGES), { wrapper });

    await waitFor(() => expect(result.current.item).toBeNull());
    expect(result.current.error).toBeNull();
  });

  it('reports a failed load instead of loading forever, and loads again on retry', async () => {
    mocks.meAttendance.mockRejectedValue(new Error('Network down'));
    const { wrapper } = setup();
    const { result } = renderHook(() => useMyAttendanceItem('shifts', 'hrshf_1', RANGES), { wrapper });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.item).toBeUndefined();

    mocks.meAttendance.mockResolvedValue(page('hrshf_1'));
    result.current.retry();
    await waitFor(() => expect(result.current.item).toEqual({ id: 'hrshf_1' }));
  });
});
