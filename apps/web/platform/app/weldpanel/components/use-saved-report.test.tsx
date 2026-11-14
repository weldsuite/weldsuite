import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSavedReport } from './use-saved-report';

const state = vi.hoisted(() => ({
  report: { id: 'rep_1', kind: 'funnel', projectId: 'wpp_2', spec: {} } as unknown,
  project: { id: 'wpp_2' } as { id: string } | undefined,
  replace: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams('report=rep_1'),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelReport: () => ({ data: state.report, isLoading: false, isError: false }),
}));
vi.mock('../lib/use-current-project', () => ({
  useCurrentProject: () => ({ project: state.project, select: state.select }),
}));

describe('useSavedReport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.project = { id: 'wpp_2' };
    state.replace.mockClear();
    state.select.mockClear();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('applies the report, and again after a remount at the same project', () => {
    const apply = vi.fn(() => true);
    const first = renderHook(() => useSavedReport({ kind: 'funnel', apply }));
    expect(apply).toHaveBeenCalledTimes(1);
    first.unmount();
    renderHook(() => useSavedReport({ kind: 'funnel', apply }));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('drops ?report= instead of pulling the user back when they switch project', () => {
    const apply = vi.fn(() => true);
    const first = renderHook(() => useSavedReport({ kind: 'funnel', apply }));
    // The builders remount when the project changes.
    first.unmount();
    state.project = { id: 'wpp_9' };
    renderHook(() => useSavedReport({ kind: 'funnel', apply }));
    expect(state.replace).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(state.select).toHaveBeenCalledTimes(1);
  });
});
