import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_IDLE_AFTER_MS, useIdleAwareRefetchInterval, useUserIdle } from './use-user-idle';

const MINUTE = 60 * 1000;

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function fire(target: EventTarget, type: string): void {
  act(() => {
    target.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  fire(document, 'visibilitychange');
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUserIdle', () => {
  it('starts active and becomes idle after the default 5 minutes without input', () => {
    const { result } = renderHook(() => useUserIdle());
    expect(result.current).toBe(false);

    advance(DEFAULT_IDLE_AFTER_MS - 1000);
    expect(result.current).toBe(false);

    advance(1000);
    expect(result.current).toBe(true);
  });

  it('input before the deadline pushes idleness back', () => {
    const { result } = renderHook(() => useUserIdle());

    advance(4 * MINUTE);
    fire(document, 'pointermove');
    advance(4 * MINUTE);
    expect(result.current).toBe(false);

    advance(MINUTE);
    expect(result.current).toBe(true);
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'])('%s counts as activity', (type) => {
    const { result } = renderHook(() => useUserIdle());
    advance(DEFAULT_IDLE_AFTER_MS);
    expect(result.current).toBe(true);

    fire(document, type);
    expect(result.current).toBe(false);
  });

  it('goes active again on input and idle again after another quiet period', () => {
    const { result } = renderHook(() => useUserIdle());
    advance(DEFAULT_IDLE_AFTER_MS);
    expect(result.current).toBe(true);

    fire(document, 'pointermove');
    expect(result.current).toBe(false);

    advance(DEFAULT_IDLE_AFTER_MS);
    expect(result.current).toBe(true);
  });

  it('treats the tab becoming visible, and window focus, as activity but not hiding it', () => {
    const { result } = renderHook(() => useUserIdle());
    advance(DEFAULT_IDLE_AFTER_MS);
    expect(result.current).toBe(true);

    setVisibility('hidden');
    expect(result.current).toBe(true);

    setVisibility('visible');
    expect(result.current).toBe(false);

    advance(DEFAULT_IDLE_AFTER_MS);
    expect(result.current).toBe(true);
    fire(window, 'focus');
    expect(result.current).toBe(false);
  });

  it('honours a custom threshold', () => {
    const { result } = renderHook(() => useUserIdle(MINUTE));
    advance(MINUTE);
    expect(result.current).toBe(true);
  });

  it('does not re-render on input while the user stays active', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useUserIdle();
    });
    const before = renders;

    for (let i = 0; i < 20; i++) {
      advance(1100);
      fire(document, 'pointermove');
    }

    expect(renders).toBe(before);
  });

  it('shares one set of document listeners and removes them with the last consumer', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');

    const first = renderHook(() => useUserIdle());
    const afterFirst = add.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = renderHook(() => useUserIdle());
    expect(add.mock.calls.length).toBe(afterFirst);

    first.unmount();
    expect(remove).not.toHaveBeenCalled();

    second.unmount();
    expect(remove.mock.calls.length).toBe(afterFirst);

    add.mockRestore();
    remove.mockRestore();
  });

  it('stops its timer on unmount', () => {
    const { unmount } = renderHook(() => useUserIdle());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a consumer that mounts while the user is already idle starts idle', () => {
    const first = renderHook(() => useUserIdle());
    advance(DEFAULT_IDLE_AFTER_MS);
    expect(first.result.current).toBe(true);

    const second = renderHook(() => useUserIdle());
    expect(second.result.current).toBe(true);
  });
});

describe('useIdleAwareRefetchInterval', () => {
  const key = ['things', 'list'] as const;

  function setup(options?: Parameters<typeof useIdleAwareRefetchInterval>[2]) {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      (props: { active?: boolean }) =>
        useIdleAwareRefetchInterval([...key], 60_000, { ...options, active: props.active ?? options?.active }),
      { wrapper, initialProps: {} as { active?: boolean } },
    );
    return { ...hook, invalidate };
  }

  it('returns the interval while the user is active and does not refresh on mount', () => {
    const { result, invalidate } = setup();
    expect(result.current).toBe(60_000);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('returns false once idle and refreshes the query exactly once when the user returns', () => {
    const { result, invalidate } = setup();

    advance(DEFAULT_IDLE_AFTER_MS);
    expect(result.current).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    fire(document, 'keydown');
    expect(result.current).toBe(60_000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true }, { cancelRefetch: false });

    // More input while active does not refresh again.
    advance(1100);
    fire(document, 'keydown');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('is off while `active` is false and refreshes once when it flips back on', () => {
    const { result, rerender, invalidate } = setup();

    rerender({ active: false });
    expect(result.current).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(result.current).toBe(60_000);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when `active` returns while the user is still idle', () => {
    const { result, rerender, invalidate } = setup();

    rerender({ active: false });
    advance(DEFAULT_IDLE_AFTER_MS);
    rerender({ active: true });

    expect(result.current).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
