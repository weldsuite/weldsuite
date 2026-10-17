import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { useCallback, type ReactNode } from 'react';
import { useObjectPanel } from './use-object-panel';
import {
  useObjectPanelNavigationControls,
  useObjectPanelNavigationShortcuts,
  useObjectPanelNavigationSource,
  type ObjectPanelNavigationSourceOptions,
  type ObjectPanelRef,
} from './use-object-panel-navigation';

function wrapper() {
  const store = createStore();
  return function StoreProvider({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

/** A list registering its rows, plus what `ObjectPanelHost` does with them. */
function useHarness(list: ObjectPanelNavigationSourceOptions) {
  useObjectPanelNavigationSource(list);
  const panel = useObjectPanel();
  const { replaceTop } = panel;
  const go = useCallback((target: ObjectPanelRef) => replaceTop(target), [replaceTop]);
  const navigation = useObjectPanelNavigationControls(panel.stack.at(-1), go);
  useObjectPanelNavigationShortcuts(navigation);
  return { ...panel, top: panel.stack.at(-1), navigation };
}

const companies = (ids: string[]): ObjectPanelNavigationSourceOptions => ({ type: 'company', ids });

describe('object panel previous / next', () => {
  it('has no arrows until a panel from the list is open', () => {
    const { result } = renderHook(() => useHarness(companies(['a', 'b'])), { wrapper: wrapper() });
    expect(result.current.navigation).toBeUndefined();

    act(() => result.current.open({ type: 'company', id: 'zzz' }));
    expect(result.current.navigation).toBeUndefined();

    act(() => result.current.open({ type: 'person', id: 'a' }));
    expect(result.current.navigation).toBeUndefined();
  });

  it('steps through the list and keeps the panel mode', () => {
    const { result } = renderHook(() => useHarness(companies(['a', 'b', 'c'])), { wrapper: wrapper() });
    act(() => result.current.open({ type: 'company', id: 'a', mode: 'fullscreen' }));

    expect(result.current.navigation?.onPrevious).toBeUndefined();
    act(() => result.current.navigation?.onNext?.());
    expect(result.current.top).toMatchObject({ type: 'company', id: 'b', mode: 'fullscreen' });

    act(() => result.current.navigation?.onNext?.());
    expect(result.current.top?.id).toBe('c');
    expect(result.current.navigation?.onNext).toBeUndefined();

    act(() => result.current.navigation?.onPrevious?.());
    expect(result.current.top?.id).toBe('b');
    expect(result.current.stack).toHaveLength(1);
  });

  it('switches type in a mixed list', () => {
    const list: ObjectPanelNavigationSourceOptions = {
      objects: [
        { type: 'company', id: 'c1' },
        { type: 'person', id: 'p1' },
      ],
    };
    const { result } = renderHook(() => useHarness(list), { wrapper: wrapper() });
    act(() => result.current.open({ type: 'company', id: 'c1' }));
    act(() => result.current.navigation?.onNext?.());
    expect(result.current.top).toMatchObject({ type: 'person', id: 'p1' });
  });

  it('loads the next page past the last loaded row, then moves on', () => {
    const loadMore = vi.fn();
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useHarness({ type: 'company', ids, hasMore: true, loadMore }),
      { wrapper: wrapper(), initialProps: { ids: ['a', 'b'] } },
    );
    act(() => result.current.open({ type: 'company', id: 'b' }));

    act(() => result.current.navigation?.onNext?.());
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(result.current.top?.id).toBe('b');

    rerender({ ids: ['a', 'b', 'c', 'd'] });
    expect(result.current.top?.id).toBe('c');
  });

  it('keeps stepping when the open object drops out of the list', () => {
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useHarness(companies(ids)), {
      wrapper: wrapper(),
      initialProps: { ids: ['a', 'b', 'c'] },
    });
    act(() => result.current.open({ type: 'company', id: 'b' }));

    // e.g. its status changed and the list is filtered on status.
    rerender({ ids: ['a', 'c'] });
    act(() => result.current.navigation?.onNext?.());
    expect(result.current.top?.id).toBe('c');
  });

  it('follows the list the panel was opened from once that list is gone', () => {
    const { result, rerender } = renderHook(
      ({ related }: { related: string[] }) => {
        // A page list and a related list (inside the open panel) both hold p2.
        useObjectPanelNavigationSource({ type: 'person', ids: ['p1', 'p2', 'p9'] });
        return useHarness({ type: 'person', ids: related });
      },
      { wrapper: wrapper(), initialProps: { related: ['p2', 'p3'] } },
    );
    act(() => result.current.open({ type: 'person', id: 'p2', stack: true }));

    // The related list unmounts (its panel is no longer on screen).
    rerender({ related: [] });
    act(() => result.current.navigation?.onNext?.());
    expect(result.current.top?.id).toBe('p3');
  });

  it('J and K step, but not while typing', () => {
    const { result } = renderHook(() => useHarness(companies(['a', 'b', 'c'])), { wrapper: wrapper() });
    act(() => result.current.open({ type: 'company', id: 'b' }));

    act(() => {
      fireEvent.keyDown(document.body, { key: 'j' });
    });
    expect(result.current.top?.id).toBe('c');

    act(() => {
      fireEvent.keyDown(document.body, { key: 'k' });
    });
    expect(result.current.top?.id).toBe('b');

    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'j' });
    });
    expect(result.current.top?.id).toBe('b');
    input.remove();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
    });
    expect(result.current.top?.id).toBe('b');
  });
});
