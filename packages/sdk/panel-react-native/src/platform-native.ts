/**
 * The {@link PanelPlatform} on React Native: `Platform`, `Dimensions` and
 * `AppState` from `react-native` core, nothing else. React Native core has no
 * API for the app's bundle id, version or build, so the app passes those in
 * (`app` option), and no model identifier on iOS, so iOS reports `iPhone` or
 * `iPad`.
 */

import { AppState, Dimensions, Platform } from 'react-native';
import { deviceTypeFromScreen, intlLocale, type DeviceInfo, type PanelPlatform, type Size } from './platform';

function screenSize(): Size | undefined {
  try {
    const { width, height } = Dimensions.get('screen');
    return { width, height };
  } catch {
    return undefined;
  }
}

/** `Google Pixel 8`, but `Pixel 8` rather than `Google Google Pixel 8`. */
function androidModel(manufacturer: unknown, model: unknown): string | undefined {
  const m = typeof model === 'string' ? model.trim() : '';
  const maker = typeof manufacturer === 'string' ? manufacturer.trim() : '';
  if (!m) return maker || undefined;
  return maker && m.toLowerCase().indexOf(maker.toLowerCase()) !== 0 ? `${maker} ${m}` : m;
}

export function deviceInfo(): DeviceInfo {
  const info: DeviceInfo = { os: Platform.OS, locale: intlLocale() };
  if (Platform.OS === 'ios') {
    const pad = Platform.isPad === true;
    info.osVersion = String(Platform.Version);
    info.deviceType = pad ? 'tablet' : 'mobile';
    info.deviceModel = pad ? 'iPad' : 'iPhone';
  } else if (Platform.OS === 'android') {
    const c = Platform.constants;
    info.osVersion = c && typeof c.Release === 'string' && c.Release ? c.Release : String(Platform.Version);
    info.deviceType = deviceTypeFromScreen(screenSize());
    info.deviceModel = c ? androidModel(c.Manufacturer, c.Model) : undefined;
  } else {
    info.osVersion = Platform.Version === undefined ? undefined : String(Platform.Version);
    info.deviceType = deviceTypeFromScreen(screenSize());
  }
  return info;
}

export function nativePlatform(): PanelPlatform {
  return {
    device: deviceInfo,
    dimensions() {
      const { width, height } = Dimensions.get('window');
      return { window: { width, height }, screen: screenSize() ?? { width, height } };
    },
    appState: () => (typeof AppState.currentState === 'string' ? AppState.currentState : null),
    onAppStateChange(listener) {
      const subscription = AppState.addEventListener('change', listener);
      return () => subscription.remove();
    },
  };
}
