/**
 * The viewport width class heatmaps and snapshot requests are grouped by.
 * One definition, used by the collector, panel-api and the query layer, so a
 * click recorded on a 1000 px window and a snapshot asked for "tablet" agree.
 */

export const DEVICE_CLASSES = ['desktop', 'tablet', 'mobile'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const MOBILE_MAX_WIDTH = 768;
export const TABLET_MAX_WIDTH = 1024;

/** < 768 px mobile, < 1024 px tablet, else desktop. An unknown width counts as desktop. */
export function deviceClassFromViewport(viewportWidth: number | null | undefined): DeviceClass {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth)) return 'desktop';
  if (viewportWidth < MOBILE_MAX_WIDTH) return 'mobile';
  if (viewportWidth < TABLET_MAX_WIDTH) return 'tablet';
  return 'desktop';
}

export function isDeviceClass(value: unknown): value is DeviceClass {
  return typeof value === 'string' && (DEVICE_CLASSES as readonly string[]).includes(value);
}
