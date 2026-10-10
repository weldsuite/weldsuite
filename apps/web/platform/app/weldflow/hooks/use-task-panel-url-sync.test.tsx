import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const state = vi.hoisted(() => ({
  pathname: '/weldflow/project/proj_1/tasks',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/lib/router', () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({ push: state.push, replace: state.replace }),
}));

import { useObjectPanel } from '@/components/object-panel/use-object-panel';
import { useTaskPanelUrlSync } from './use-task-panel-url-sync';

function useHarness() {
  useTaskPanelUrlSync();
  return useObjectPanel();
}

describe('useTaskPanelUrlSync', () => {
  beforeEach(() => {
    state.pathname = '/weldflow/project/proj_1/tasks';
    state.search = '';
    state.push.mockClear();
    state.replace.mockClear();
  });

  it('opens the task named in ?stack= on load without rewriting the URL', () => {
    state.search = 'stack=task:task_abc:panel';
    const { result } = renderHook(useHarness);

    expect(result.current.stack).toHaveLength(1);
    expect(result.current.stack[0]).toMatchObject({ type: 'task', id: 'task_abc', mode: 'panel' });
    expect(state.push).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('writes the stack to the URL (as a new history entry) when a task is opened, and drops it on close', () => {
    const { result, rerender } = renderHook(useHarness);

    act(() => result.current.open({ type: 'task', id: 'task_xyz' }));
    expect(state.push).toHaveBeenCalledTimes(1);
    const pushed = String(state.push.mock.calls[0][0]);
    expect(pushed.startsWith('/weldflow/project/proj_1/tasks?stack=')).toBe(true);
    expect(decodeURIComponent(pushed)).toContain('task:task_xyz');

    // The router reflects the pushed URL.
    state.search = 'stack=task:task_xyz';
    rerender();
    expect(state.replace).not.toHaveBeenCalled();

    act(() => result.current.close());
    expect(state.replace).toHaveBeenCalledWith('/weldflow/project/proj_1/tasks');
  });

  it('closes the panel when Back removes the param', () => {
    state.search = 'stack=task:task_abc:panel';
    const { result, rerender } = renderHook(useHarness);
    expect(result.current.stack).toHaveLength(1);

    state.search = '';
    rerender();
    expect(result.current.stack).toHaveLength(0);
    expect(state.push).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
  });
});
