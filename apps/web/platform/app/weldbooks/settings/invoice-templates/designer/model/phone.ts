/** devices.css iPhone 14 Pro: the whole device, and the strip at the top of the screen the Dynamic Island covers. */
export const PHONE = { width: 428, height: 868 };
/**
 * The screen inside the frame. devices.css draws it 390 x 830 in a frame that
 * leaves 388 x 828 (428 - 2 x (1px border + 19px bezel)), so its screen
 * overflows 2px to the right and bottom: uneven bezels and a Dynamic Island
 * 1px off centre. This is the size that fits, with corners concentric to
 * the frame's 68px ones (68 - 20 = 48).
 */
export const SCREEN = { width: 388, height: 828, radius: 48 };
export const SAFE_TOP = 54;
/**
 * The Dynamic Island in screen coordinates: devices.css draws it 120 x 35,
 * centred, 29px from the top of the device, which is 9px into the screen.
 * The status bar centres its two halves on the island's middle line.
 */
export const ISLAND = { width: 120, top: 9, height: 35 };
/** Room around the phone in the canvas. */
export const CHROME = 64;
/** Largest scale: a little under real size, so the phone sits comfortably in the canvas. */
export const MAX_SCALE = 0.875;
export const MIN_SCALE = 0.5;

/**
 * A scale at which the phone's 428 x 868 frame (and the devices.css parts on
 * whole-pixel offsets) lands on whole screen pixels: multiples of 1/4 at 1x,
 * 1/8 on Retina. Any other scale puts edges between pixels, which the browser
 * smears into soft, grey seams.
 */
export function crispScale(fit: number, devicePixelRatio: number): number {
  const step = 1 / (4 * Math.max(1, Math.round(devicePixelRatio)));
  const wanted = Math.min(MAX_SCALE, fit);
  return Math.max(MIN_SCALE, Math.floor(wanted / step + 1e-9) * step);
}
