import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ weldhr: {} }) }));

import {
  useLoadedHrOpenShift,
  useLoadedHrShift,
  useLoadedHrShiftRequest,
  useLoadedMyAttendanceItem,
  weldhrKeys,
} from './use-weldhr-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

const list = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) });

describe('useLoadedHrShift', () => {
  it('is undefined while no shift list has loaded', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useLoadedHrShift('shift_1'), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('finds the shift in any loaded list', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.shifts({ from: '2026-11-01', to: '2026-11-07' }), list('shift_a'));
    client.setQueryData(weldhrKeys.shifts({ from: '2026-11-08', to: '2026-11-14' }), list('shift_b'));
    const { result } = renderHook(() => useLoadedHrShift('shift_b'), { wrapper });
    expect(result.current).toEqual({ id: 'shift_b' });
  });

  it('is null when lists have loaded but none has the shift', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.shifts({ from: '2026-11-01', to: '2026-11-07' }), list('shift_a'));
    const { result } = renderHook(() => useLoadedHrShift('shift_gone'), { wrapper });
    expect(result.current).toBeNull();
  });

  it('skips a list that is still loading', () => {
    const { client, wrapper } = setup();
    void client.prefetchQuery({ queryKey: weldhrKeys.shifts({ page: 'pending' }), queryFn: () => new Promise(() => undefined) });
    const { result } = renderHook(() => useLoadedHrShift('shift_a'), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('follows a list loading after the first render', () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useLoadedHrShift('shift_late'), { wrapper });
    expect(result.current).toBeUndefined();
    act(() => {
      client.setQueryData(weldhrKeys.shifts({ from: '2026-11-01', to: '2026-11-07' }), list('shift_late'));
    });
    expect(result.current).toEqual({ id: 'shift_late' });
  });

  it('follows an edit of the shift in the list', () => {
    const { client, wrapper } = setup();
    const key = weldhrKeys.shifts({ from: '2026-11-01', to: '2026-11-07' });
    client.setQueryData(key, { data: [{ id: 'shift_a', workType: 'Early' }] });
    const { result } = renderHook(() => useLoadedHrShift('shift_a'), { wrapper });
    expect(result.current).toMatchObject({ workType: 'Early' });
    act(() => {
      client.setQueryData(key, { data: [{ id: 'shift_a', workType: 'Late' }] });
    });
    expect(result.current).toMatchObject({ workType: 'Late' });
  });
});

describe('useLoadedHrShiftRequest', () => {
  it('finds a request in the request lists, and is null when none has it', () => {
    const { client, wrapper } = setup();
    const { result: before } = renderHook(() => useLoadedHrShiftRequest('sr_1'), { wrapper });
    expect(before.current).toBeUndefined();

    client.setQueryData(weldhrKeys.shiftRequests({ status: 'pending' }), list('sr_1'));
    const { result: found } = renderHook(() => useLoadedHrShiftRequest('sr_1'), { wrapper });
    const { result: missing } = renderHook(() => useLoadedHrShiftRequest('sr_2'), { wrapper });
    expect(found.current).toEqual({ id: 'sr_1' });
    expect(missing.current).toBeNull();
  });

  it('does not look in the shift lists', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.shifts({}), list('sr_1'));
    const { result } = renderHook(() => useLoadedHrShiftRequest('sr_1'), { wrapper });
    expect(result.current).toBeUndefined();
  });
});

describe('useLoadedHrOpenShift', () => {
  it('finds an open shift in the open-shift lists, and is null when none has it', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.openShifts({ from: '2026-11-23' }), list('os_1'));
    const { result: found } = renderHook(() => useLoadedHrOpenShift('os_1'), { wrapper });
    const { result: missing } = renderHook(() => useLoadedHrOpenShift('os_2'), { wrapper });
    expect(found.current).toEqual({ id: 'os_1' });
    expect(missing.current).toBeNull();
  });
});

describe('useLoadedMyAttendanceItem', () => {
  const range = { from: '2026-10-25', to: '2026-12-07' };
  const attendance = { data: { shifts: [{ id: 'hrshf_1' }], records: [{ id: 'hrrec_1' }] } };

  it('is undefined while no period has loaded', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useLoadedMyAttendanceItem('records', 'hrrec_1'), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('finds a clock record, and a shift, in a loaded period', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.me('attendance', range), attendance);
    const { result: record } = renderHook(() => useLoadedMyAttendanceItem('records', 'hrrec_1'), { wrapper });
    const { result: shift } = renderHook(() => useLoadedMyAttendanceItem('shifts', 'hrshf_1'), { wrapper });
    expect(record.current).toEqual({ id: 'hrrec_1' });
    expect(shift.current).toEqual({ id: 'hrshf_1' });
  });

  it('does not mix up the two kinds', () => {
    const { client, wrapper } = setup();
    client.setQueryData(weldhrKeys.me('attendance', range), attendance);
    const { result } = renderHook(() => useLoadedMyAttendanceItem('records', 'hrshf_1'), { wrapper });
    expect(result.current).toBeNull();
  });

  it('skips a period that is still loading', () => {
    const { client, wrapper } = setup();
    void client.prefetchQuery({ queryKey: weldhrKeys.me('attendance', range), queryFn: () => new Promise(() => undefined) });
    const { result } = renderHook(() => useLoadedMyAttendanceItem('shifts', 'hrshf_1'), { wrapper });
    expect(result.current).toBeUndefined();
  });
});
