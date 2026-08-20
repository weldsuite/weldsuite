import { useEffect, useRef } from 'react';
import {
  addZebraScanListener,
  configureZebraProfile,
  isZebraScannerAvailable,
} from '@/modules/zebra-datawedge';
import { normalizeBarcode } from '@/utils/barcode';

/**
 * Subscribe to hardware barcode scans.
 *
 * Zebra Android computers deliver scans through DataWedge as a broadcast
 * intent (`com.weldsuite.weldstash.SCAN`). The native module drops broadcasts
 * that are not from DataWedge. USB / keyboard-wedge scanners still type into
 * the focused search field and submit with Enter — that path is handled by
 * the search bar, not this hook.
 */
export function useHardwareBarcodeScan(onScan: (code: string) => void): boolean {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!isZebraScannerAvailable()) return;

    configureZebraProfile();
    const subscription = addZebraScanListener((event) => {
      const code = normalizeBarcode(event.data);
      if (code) onScanRef.current(code);
    });

    return () => subscription.remove();
  }, []);

  return isZebraScannerAvailable();
}
