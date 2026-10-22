/**
 * JS facade for the local Zebra DataWedge Expo module.
 *
 * On Zebra Android computers DataWedge forwards hardware scans as a broadcast
 * intent (`com.weldsuite.weldstash.SCAN` only). The native receiver is exported
 * so DataWedge can send, but it rejects broadcasts that are not from
 * `com.symbol.datawedge` when Android reports the sender, and it requires
 * DataWedge's signature permission from the sender when that permission exists.
 *
 * The native module is compiled into every Android build, so it being present
 * says nothing about the device: it also reports whether DataWedge itself is
 * installed (`isSupported`). On iOS / simulators / Android phones without
 * DataWedge these helpers no-op — keyboard-wedge scanners still work through
 * the search field's Enter submit.
 */

import { requireOptionalNativeModule } from 'expo';

export type BarcodeScanEvent = {
  data: string;
  labelType?: string;
};

type ScanSubscription = {
  remove: () => void;
};

type ZebraDataWedgeNative = {
  /** True only when the DataWedge package is installed and enabled. */
  isSupported: () => boolean;
  configureProfile: () => void;
  addListener: (
    event: 'onBarcodeScanned',
    listener: (event: BarcodeScanEvent) => void,
  ) => ScanSubscription;
};

const native = requireOptionalNativeModule<ZebraDataWedgeNative>('ZebraDataWedge');

let available: boolean | undefined;

/**
 * Whether this device has a hardware (Zebra DataWedge) scanner. Cached: the
 * answer cannot change while the app runs.
 */
export function isZebraScannerAvailable(): boolean {
  if (available === undefined) {
    try {
      available = native != null && native.isSupported() === true;
    } catch {
      available = false;
    }
  }
  return available;
}

export function configureZebraProfile(): void {
  if (!native || !isZebraScannerAvailable()) return;
  native.configureProfile();
}

export function addZebraScanListener(
  listener: (event: BarcodeScanEvent) => void,
): ScanSubscription {
  if (!native || !isZebraScannerAvailable()) {
    return { remove() {} };
  }
  return native.addListener('onBarcodeScanned', listener);
}
