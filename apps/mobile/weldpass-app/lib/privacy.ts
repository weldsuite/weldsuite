/**
 * Keeping secrets off screenshots and the app switcher.
 *
 * - The app switcher: iOS blurs WeldPass's snapshot
 *   (`enableAppSwitcherProtectionAsync`). Android has no separate switch:
 *   `FLAG_SECURE` blanks the recent-apps preview, and also blocks
 *   screenshots and screen recording, so on Android that holds app-wide.
 * - Item screens (`usePreventScreenshots`) block screenshots on iOS too.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

const APP_KEY = 'weldpass-app';

/** Mounted once, in the root layout. */
export function useAppSwitcherCover(): void {
  useEffect(() => {
    if (Platform.OS === 'ios') {
      ScreenCapture.enableAppSwitcherProtectionAsync(1).catch(() => {});
      return () => {
        ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => {});
      };
    }
    if (Platform.OS === 'android') {
      ScreenCapture.preventScreenCaptureAsync(APP_KEY).catch(() => {});
      return () => {
        ScreenCapture.allowScreenCaptureAsync(APP_KEY).catch(() => {});
      };
    }
    return undefined;
  }, []);
}

/** On screens that show an item's fields. */
export function usePreventScreenshots(): void {
  ScreenCapture.usePreventScreenCapture('weldpass-item');
}
