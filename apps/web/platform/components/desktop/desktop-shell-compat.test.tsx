import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// The platform is served live to every installed desktop shell. Shell 0.1.0's
// preload has no `onSelectSource` / `onNotificationClick`; calling them threw
// from root-level effects and left the app stuck on "Something went wrong".
let desktopApi: Record<string, unknown> | null = null;

vi.mock('@/lib/desktop', () => ({
  getDesktop: () => desktopApi,
  isDesktop: () => desktopApi !== null,
}));

import { DesktopSourcePicker } from './desktop-source-picker';
import { onOsNotificationClick } from '@/lib/desktop-notifications';

const legacyShell = () => ({
  isDesktop: true,
  platform: 'win32',
  reloadApp: vi.fn(),
  setBadgeCount: vi.fn(),
  flashFrame: vi.fn(),
  showNotification: vi.fn(),
});

describe('desktop shell 0.1.0 compatibility', () => {
  beforeEach(() => {
    desktopApi = legacyShell();
  });

  it('mounts the source picker without the picker bridge', () => {
    expect(() => render(<DesktopSourcePicker />)).not.toThrow();
  });

  it('subscribes to notification clicks without the click bridge', () => {
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = onOsNotificationClick(() => {});
    }).not.toThrow();
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it('still registers with shells that have the bridge', () => {
    const unsubscribe = vi.fn();
    const onSelectSource = vi.fn(() => unsubscribe);
    desktopApi = { ...legacyShell(), onSelectSource };

    const { unmount } = render(<DesktopSourcePicker />);
    expect(onSelectSource).toHaveBeenCalledOnce();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
