/**
 * JS facade for the local Zebra DataWedge Expo module.
 *
 * On Zebra Android computers DataWedge forwards hardware scans as a broadcast
 * intent (`com.weldsuite.weldwms.SCAN` only). The native receiver is exported
 * so DataWedge can send, but it rejects broadcasts that are not from
 * `com.symbol.datawedge` when Android reports the sender, and it requires
 * DataWedge's signature permission from the sender when that permission exists.
 * On iOS / simulators / non-Zebra devices the native module is absent and
 * these helpers no-op — keyboard-wedge scanners still work through the search
 * field's Enter submit.
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
  configureProfile: () => void;
  addListener: (
    event: 'onBarcodeScanned',
    listener: (event: BarcodeScanEvent) => void,
  ) => ScanSubscription;
};

const native = requireOptionalNativeModule<ZebraDataWedgeNative>('ZebraDataWedge');

export function isZebraScannerAvailable(): boolean {
  return native != null;
}

export function configureZebraProfile(): void {
  native?.configureProfile();
}

export function addZebraScanListener(
  listener: (event: BarcodeScanEvent) => void,
): ScanSubscription {
  if (!native) {
    return { remove() {} };
  }
  return native.addListener('onBarcodeScanned', listener);
}
