import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyRouteComponent } from '@tanstack/react-router';

type ChunkReload = typeof import('./chunk-reload');

const STALE = 'Failed to fetch dynamically imported module: https://app.weldsuite.org/assets/page-abc123.js';

const originalLocation = window.location;
let reload: ReturnType<typeof vi.fn>;
let mod: ChunkReload;

beforeEach(async () => {
  // The hold registry is module state: start every test from a fresh module.
  vi.resetModules();
  mod = await import('./chunk-reload');
  sessionStorage.clear();
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('isStaleChunkError', () => {
  it.each([
    STALE,
    'error loading dynamically imported module: https://app.weldsuite.org/assets/a.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/page-abc123.css',
    "Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of 'text/html'.",
  ])('recognises %s', (message) => {
    expect(mod.isStaleChunkError(new TypeError(message))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(mod.isStaleChunkError(new Error('boom'))).toBe(false);
    expect(mod.isStaleChunkError(undefined)).toBe(false);
  });
});

describe('reloadForStaleChunk', () => {
  it('reloads when no call is live, once per guard window', () => {
    expect(mod.reloadForStaleChunk()).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(mod.reloadForStaleChunk()).toBe('suppressed');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for the call to end, then reloads after the grace period', () => {
    const release = mod.holdStaleChunkReload();
    expect(mod.reloadForStaleChunk()).toBe('deferred');
    expect(mod.getStaleChunkReloadState()).toEqual({ held: true, pending: true });
    expect(reload).not.toHaveBeenCalled();

    release();
    expect(mod.getStaleChunkReloadState()).toEqual({ held: false, pending: true });
    vi.advanceTimersByTime(mod.HELD_RELOAD_GRACE_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when the user switches straight into another call', () => {
    const leaveFirst = mod.holdStaleChunkReload();
    mod.reloadForStaleChunk();
    leaveFirst();
    vi.advanceTimersByTime(500);
    const leaveSecond = mod.holdStaleChunkReload();
    vi.advanceTimersByTime(mod.HELD_RELOAD_GRACE_MS * 2);
    expect(reload).not.toHaveBeenCalled();

    leaveSecond();
    vi.advanceTimersByTime(mod.HELD_RELOAD_GRACE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('holds while any call is live', () => {
    const releaseChat = mod.holdStaleChunkReload();
    const releasePhone = mod.holdStaleChunkReload();
    mod.reloadForStaleChunk();
    releaseChat();
    releaseChat(); // releasing twice does not drop another call's hold
    vi.advanceTimersByTime(mod.HELD_RELOAD_GRACE_MS * 2);
    expect(reload).not.toHaveBeenCalled();
    releasePhone();
    vi.advanceTimersByTime(mod.HELD_RELOAD_GRACE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload after a call when no update came in', () => {
    const release = mod.holdStaleChunkReload();
    release();
    vi.advanceTimersByTime(mod.HELD_RELOAD_GRACE_MS * 2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('tells subscribers when an update starts waiting', async () => {
    const listener = vi.fn();
    mod.subscribeStaleChunkReload(listener);
    mod.holdStaleChunkReload();
    mod.reloadForStaleChunk();
    mod.reloadForStaleChunk();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2); // held, then pending; the repeat changes nothing
  });
});

describe('keepRouterFromReloading', () => {
  // TanStack Router's lazy route component reloads by itself when its chunk is
  // missing. These pin how it decides, which keepRouterFromReloading relies on.
  function failedRouteComponent(error: Error) {
    const Lazy = lazyRouteComponent(() => Promise.reject(error)) as unknown as ((props: object) => unknown) & {
      preload: () => Promise<void>;
    };
    return Lazy;
  }

  function renderOnce(Lazy: (props: object) => unknown): unknown {
    try {
      return Lazy({});
    } catch (thrown) {
      return thrown;
    }
  }

  it('the router reloads on a missing route chunk by default', async () => {
    const Lazy = failedRouteComponent(new TypeError(STALE));
    await Lazy.preload();
    renderOnce(Lazy);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stops the router from reloading, so the route error boundary gets the error', async () => {
    const error = new TypeError(STALE);
    mod.keepRouterFromReloading(error);
    const Lazy = failedRouteComponent(error);
    await Lazy.preload();
    expect(renderOnce(Lazy)).toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });
});
