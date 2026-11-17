/**
 * What the SDK needs from React Native, behind a small interface so the core
 * runs (and is tested) anywhere. The real one is `platform-native.ts`, the
 * only file that imports `react-native`.
 */

export type DeviceType = 'mobile' | 'tablet';

export interface Size {
  width: number;
  height: number;
}

/** What the SDK sends about the device on every event (`$os`, `$device_type`, …). Fields left out are not sent. */
export interface DeviceInfo {
  /** `Platform.OS`: `ios`, `android`, … */
  os?: string;
  osVersion?: string;
  deviceType?: DeviceType;
  deviceModel?: string;
  /** BCP 47, `en-US`. */
  locale?: string;
}

export interface PanelPlatform {
  /** Read once, when the SDK starts. */
  device(): DeviceInfo;
  /** The app window (`viewport_w`) and the whole screen (`$screen_width`, `$screen_height`), in dp. */
  dimensions(): { window: Size; screen: Size };
  /** `AppState.currentState`: `active`, `background`, `inactive`, … or null when unknown. */
  appState(): string | null;
  /** Subscribe to app state changes; returns the unsubscribe. */
  onAppStateChange(listener: (state: string) => void): () => void;
}

/** The runtime's locale from `Intl`, when it has one (Hermes does). */
export function intlLocale(): string | undefined {
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof locale === 'string' && locale ? locale : undefined;
  } catch {
    return undefined;
  }
}

/** The usual Android split: a screen whose shorter side is at least 600 dp is a tablet. */
export function deviceTypeFromScreen(screen: Size | undefined): DeviceType | undefined {
  // NaN when a side is missing or not a number: no device type then, as for a side of 0 or less.
  const shorter = screen ? Math.min(screen.width, screen.height) : Number.NaN;
  if (shorter > 0) return shorter >= 600 ? 'tablet' : 'mobile';
  return undefined;
}
