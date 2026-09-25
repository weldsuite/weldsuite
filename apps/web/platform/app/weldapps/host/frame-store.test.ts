import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  MAX_LIVE_FRAMES,
  __resetFrameStoreForTests,
  attachFrameSlot,
  clearWeldAppFrames,
  detachFrameSlot,
  preloadWeldApp,
  updateFrameStatus,
  useWeldAppFrames,
  useWeldAppFrameSlot,
  useWeldAppFrameStatus,
} from './frame-store';

function element(): HTMLElement {
  return document.createElement('div');
}

describe('WeldApp frame store', () => {
  beforeEach(() => {
    __resetFrameStoreForTests();
  });

  it('keeps at most MAX_LIVE_FRAMES frames, evicting the least recently used', () => {
    const { result } = renderHook(() => useWeldAppFrames());
    act(() => {
      for (let i = 0; i <= MAX_LIVE_FRAMES; i += 1) preloadWeldApp(`app${i}`);
    });
    expect(result.current).toHaveLength(MAX_LIVE_FRAMES);
    expect(result.current).not.toContain('app0');
  });

  it('never evicts the app currently shown', () => {
    const { result } = renderHook(() => useWeldAppFrames());
    const slot = element();
    act(() => {
      attachFrameSlot({ appCode: 'shown', element: slot, path: '/' });
      for (let i = 0; i < MAX_LIVE_FRAMES + 2; i += 1) preloadWeldApp(`bg${i}`);
    });
    expect(result.current).toContain('shown');
  });

  it('hides but keeps a frame when its page unmounts', () => {
    const frames = renderHook(() => useWeldAppFrames());
    const slot = renderHook(() => useWeldAppFrameSlot());
    const el = element();
    act(() => attachFrameSlot({ appCode: 'demo', element: el, path: '/orders' }));
    expect(slot.result.current?.path).toBe('/orders');
    act(() => detachFrameSlot(el));
    expect(slot.result.current).toBeNull();
    expect(frames.result.current).toContain('demo');
  });

  it('ignores a stale detach from a previous page instance', () => {
    const slot = renderHook(() => useWeldAppFrameSlot());
    const first = element();
    const second = element();
    act(() => {
      attachFrameSlot({ appCode: 'demo', element: first, path: '/' });
      attachFrameSlot({ appCode: 'demo', element: second, path: '/' });
      detachFrameSlot(first);
    });
    expect(slot.result.current?.element).toBe(second);
  });

  it('tracks status per app and clears everything on workspace switch', () => {
    const status = renderHook(() => useWeldAppFrameStatus('demo'));
    act(() => {
      preloadWeldApp('demo');
      updateFrameStatus('demo', { mounted: true, dirty: { message: 'Unsaved' } });
    });
    expect(status.result.current).toMatchObject({ mounted: true, dirty: { message: 'Unsaved' } });
    act(() => clearWeldAppFrames());
    expect(status.result.current).toMatchObject({ mounted: false, dirty: null });
  });
});
