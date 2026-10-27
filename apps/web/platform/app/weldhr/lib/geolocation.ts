/** The device's position from the browser, for clocking in at a work location and for setting one up. */

import type { HrGeoPointInput } from '@weldsuite/app-api-client/schemas/weldhr';

/** Why no position came back: the browser has no geolocation, the person said no, or no fix was found in time. */
export type GeolocationFailure = 'unsupported' | 'denied' | 'unavailable';

export class GeolocationError extends Error {
  constructor(readonly reason: GeolocationFailure) {
    super(`Geolocation ${reason}`);
    this.name = 'GeolocationError';
  }
}

/** Long enough for a phone to get a GPS fix indoors, short enough that a button press does not hang. */
const POSITION_TIMEOUT_MS = 15_000;

/**
 * Asks the browser for the current position, with high accuracy. Rejects with
 * a `GeolocationError` so the caller can show a message that fits what failed.
 */
export function getDevicePosition(): Promise<HrGeoPointInput> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new GeolocationError('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      (error) => reject(new GeolocationError(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable')),
      { enableHighAccuracy: true, timeout: POSITION_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}
