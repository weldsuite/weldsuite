import { afterEach, describe, expect, it, vi } from 'vitest';
import { WELDSTASH_SETTINGS_PATH, openWeldStashSettings } from './open-settings';

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('openWeldStashSettings', () => {
  it('remembers the page without its workspace prefix and opens the settings', () => {
    window.history.pushState({}, '', '/w/acme/weldstash/replenishment');
    const router = { push: vi.fn() };
    openWeldStashSettings(router);
    expect(sessionStorage.getItem('settings-return-url')).toBe('/weldstash/replenishment');
    expect(router.push).toHaveBeenCalledWith(WELDSTASH_SETTINGS_PATH);
  });

  it('still opens the settings when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const router = { push: vi.fn() };
    openWeldStashSettings(router);
    expect(router.push).toHaveBeenCalledWith('/settings/apps/weldstash');
  });
});
