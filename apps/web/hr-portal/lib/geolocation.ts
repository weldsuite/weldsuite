/**
 * The device's position for clocking in while the workspace requires being at
 * a work location. The worker decides whether it is close enough; this only
 * asks the browser.
 */

export interface DevicePosition {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

/** Why no position: the person said no, or the browser could not get one. */
export type PositionFailure = 'denied' | 'unavailable';

export class PositionError extends Error {
  constructor(readonly reason: PositionFailure) {
    super(reason);
    this.name = 'PositionError';
  }
}

export function currentPosition(timeoutMs = 15_000): Promise<DevicePosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new PositionError('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        }),
      (err) => reject(new PositionError(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}
