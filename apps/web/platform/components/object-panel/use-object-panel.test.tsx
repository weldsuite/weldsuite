import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { useObjectPanel } from './use-object-panel';

function wrapper() {
  const store = createStore();
  return function StoreProvider({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

describe('useObjectPanel open mode', () => {
  it('opens in panel mode when nothing is open', () => {
    const { result } = renderHook(useObjectPanel, { wrapper: wrapper() });
    act(() => result.current.open({ type: 'customer', id: 'a' }));
    expect(result.current.stack.at(-1)).toMatchObject({ id: 'a', mode: 'panel' });
  });

  it('keeps an expanded panel expanded when a record is opened on top of it', () => {
    const { result } = renderHook(useObjectPanel, { wrapper: wrapper() });
    act(() => result.current.open({ type: 'customer', id: 'a' }));
    act(() => result.current.setMode(0, 'fullscreen'));
    act(() => result.current.open({ type: 'task', id: 't', stack: true }));

    expect(result.current.stack).toHaveLength(2);
    expect(result.current.stack.at(-1)).toMatchObject({ type: 'task', id: 't', mode: 'fullscreen' });
  });

  it('keeps an expanded panel expanded when another record replaces it', () => {
    const { result } = renderHook(useObjectPanel, { wrapper: wrapper() });
    act(() => result.current.open({ type: 'customer', id: 'a', mode: 'fullscreen' }));
    act(() => result.current.open({ type: 'project', id: 'p' }));

    expect(result.current.stack).toHaveLength(1);
    expect(result.current.stack[0]).toMatchObject({ type: 'project', id: 'p', mode: 'fullscreen' });
  });

  it('stays minimized when opened from a minimized panel', () => {
    const { result } = renderHook(useObjectPanel, { wrapper: wrapper() });
    act(() => result.current.open({ type: 'customer', id: 'a' }));
    act(() => result.current.open({ type: 'contact', id: 'c', stack: true }));
    expect(result.current.stack.at(-1)).toMatchObject({ id: 'c', mode: 'panel' });
  });

  it('honours an explicit mode over the open panel', () => {
    const { result } = renderHook(useObjectPanel, { wrapper: wrapper() });
    act(() => result.current.open({ type: 'customer', id: 'a', mode: 'fullscreen' }));
    act(() => result.current.open({ type: 'contact', id: 'c', mode: 'panel', stack: true }));
    expect(result.current.stack.at(-1)).toMatchObject({ id: 'c', mode: 'panel' });
  });
});
