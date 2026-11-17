import { afterEach, describe, expect, it, vi } from 'vitest';

const rn = vi.hoisted(() => {
  const listeners: Array<(state: string) => void> = [];
  return {
    listeners,
    Platform: {
      OS: 'ios' as string,
      Version: '17.4' as string | number | undefined,
      isPad: false as boolean | undefined,
      constants: {} as Record<string, unknown> | undefined,
    },
    Dimensions: {
      get: vi.fn((which: 'window' | 'screen') => (which === 'window' ? { width: 390, height: 800 } : { width: 390, height: 844 })),
    },
    AppState: {
      currentState: 'active' as string | null,
      addEventListener: vi.fn((_type: string, listener: (state: string) => void) => {
        listeners.push(listener);
        return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
      }),
    },
  };
});

vi.mock('react-native', () => ({ Platform: rn.Platform, Dimensions: rn.Dimensions, AppState: rn.AppState }));

import { createWeldPanel } from './index';
import { deviceTypeFromScreen, type Size } from './platform';
import { deviceInfo, nativePlatform } from './platform-native';
import { fakeNetwork, memoryStorage } from './test/harness';

afterEach(() => {
  Object.assign(rn.Platform, { OS: 'ios', Version: '17.4', isPad: false, constants: {} });
  rn.Dimensions.get.mockImplementation((which) => (which === 'window' ? { width: 390, height: 800 } : { width: 390, height: 844 }));
});

describe('the React Native platform', () => {
  it('iPhone and iPad', () => {
    expect(deviceInfo()).toMatchObject({ os: 'ios', osVersion: '17.4', deviceType: 'mobile', deviceModel: 'iPhone' });
    rn.Platform.isPad = true;
    expect(deviceInfo()).toMatchObject({ deviceType: 'tablet', deviceModel: 'iPad' });
  });

  it('Android: release, maker and model, tablet by screen size', () => {
    Object.assign(rn.Platform, { OS: 'android', Version: 34, constants: { Release: '14', Manufacturer: 'Google', Model: 'Pixel 8' } });
    expect(deviceInfo()).toMatchObject({ os: 'android', osVersion: '14', deviceType: 'mobile', deviceModel: 'Google Pixel 8' });
    rn.Platform.constants = { Release: '', Manufacturer: 'samsung', Model: 'samsung SM-X710' };
    rn.Dimensions.get.mockImplementation(() => ({ width: 1600, height: 2560 }));
    expect(deviceInfo()).toMatchObject({ osVersion: '34', deviceType: 'tablet', deviceModel: 'samsung SM-X710' });
  });

  it('tablet from a shorter side of 600 dp, and no device type for a missing or unusable size', () => {
    expect(deviceTypeFromScreen({ width: 600, height: 960 })).toBe('tablet');
    expect(deviceTypeFromScreen({ width: 1024, height: 599.5 })).toBe('mobile');
    expect(deviceTypeFromScreen({ width: Infinity, height: 700 })).toBe('tablet');
    for (const screen of [undefined, { width: 0, height: 800 }, { width: 800, height: -1 }, { width: Number.NaN, height: 800 }, { width: 800, height: Number.NaN }]) {
      expect(deviceTypeFromScreen(screen), JSON.stringify(screen)).toBeUndefined();
    }
    expect(deviceTypeFromScreen({ height: 800 } as unknown as Size)).toBeUndefined();
  });

  it('reads the locale from Intl', () => {
    expect(deviceInfo().locale).toBe(new Intl.DateTimeFormat().resolvedOptions().locale);
  });

  it('dimensions and app state come from Dimensions and AppState', () => {
    const platform = nativePlatform();
    expect(platform.dimensions()).toEqual({ window: { width: 390, height: 800 }, screen: { width: 390, height: 844 } });
    expect(platform.appState()).toBe('active');
    const seen: string[] = [];
    const unsubscribe = platform.onAppStateChange((s) => seen.push(s));
    for (const listener of [...rn.listeners]) listener('background');
    unsubscribe();
    expect(rn.listeners).toHaveLength(0);
    expect(seen).toEqual(['background']);
  });
});

describe('createWeldPanel', () => {
  it('uses the React Native platform by default', async () => {
    const net = fakeNetwork();
    const panel = createWeldPanel({ token: 'wpk_test', storage: memoryStorage(), fetch: net.fetch, app: { id: 'com.acme.shop' } });
    await panel.ready;
    expect(rn.listeners).toHaveLength(1);
    await panel.flush();
    expect(net.events()[0]).toMatchObject({ name: '$app_opened', url: 'app://com.acme.shop/', viewport_w: 390 });
    expect(net.events()[0].props).toMatchObject({ $os: 'ios', $device_model: 'iPhone', $screen_height: 844 });
    panel.shutdown();
    expect(rn.listeners).toHaveLength(0);
  });

  it('does nothing without a token', async () => {
    const panel = createWeldPanel({ token: '' });
    panel.track('Nothing');
    await expect(panel.flush()).resolves.toBeUndefined();
    expect(panel.getDistinctId()).toBeNull();
    expect(rn.listeners).toHaveLength(0);
  });
});
