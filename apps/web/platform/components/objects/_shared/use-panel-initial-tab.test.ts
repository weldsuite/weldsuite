import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePanelInitialTab } from './use-panel-initial-tab';

type Tab = { id: 'overview' | 'items' | 'holds' };
const loading: Tab[] = [{ id: 'overview' }, { id: 'items' }];
const loaded: Tab[] = [...loading, { id: 'holds' }];

describe('usePanelInitialTab', () => {
  it('opens on the asked-for tab when it is there from the start', () => {
    const { result } = renderHook(() => usePanelInitialTab(loaded, 'holds', 'overview'));
    expect(result.current[0]).toBe('holds');
  });

  it('switches to the asked-for tab once the record brings it', () => {
    const { result, rerender } = renderHook(({ tabs }) => usePanelInitialTab(tabs, 'holds', 'overview'), {
      initialProps: { tabs: loading },
    });
    expect(result.current[0]).toBe('overview');

    rerender({ tabs: loaded });
    expect(result.current[0]).toBe('holds');
  });

  it('leaves a tab the member picked in the meantime alone', () => {
    const { result, rerender } = renderHook(({ tabs }) => usePanelInitialTab(tabs, 'holds', 'overview'), {
      initialProps: { tabs: loading },
    });
    act(() => result.current[1]('items'));

    rerender({ tabs: loaded });
    expect(result.current[0]).toBe('items');
  });
});
