/**
 * JS facade for the local Zebra DataWedge Expo module.
 *
 * On Zebra Android computers DataWedge forwards hardware scans as a broadcast
 * intent. This module listens for that broadcast and also creates the WeldWMS
 * DataWedge profile on start. On iOS / simulators / non-Zebra devices the
 * native module is absent and these helpers no-op — keyboard-wedge scanners
 * still work through the search field's Enter submit.
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
