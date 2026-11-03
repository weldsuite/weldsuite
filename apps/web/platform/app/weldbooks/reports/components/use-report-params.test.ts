import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReportParams } from './use-report-params';

describe('useReportParams', () => {
  it('holds the request at the last valid range while From is after To', () => {
    const { result } = renderHook(() => useReportParams());
    act(() => result.current.update({ from: '2026-01-01', to: '2026-06-30' }));
    expect(result.current.query).toEqual({ from: '2026-01-01', to: '2026-06-30' });

    act(() => result.current.update({ from: '2026-12-31' }));
    expect(result.current.params.from).toBe('2026-12-31');
    expect(result.current.query).toEqual({ from: '2026-01-01', to: '2026-06-30' });

    act(() => result.current.update({ to: '2026-12-31' }));
    expect(result.current.query).toEqual({ from: '2026-12-31', to: '2026-12-31' });
  });

  it('asks for the defaults when the very first range is reversed', () => {
    const { result } = renderHook(() => useReportParams({ from: '2026-12-31', to: '2026-01-01' }));
    expect(result.current.query).toEqual({});
  });
});
