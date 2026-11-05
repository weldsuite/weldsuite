/**
 * The crop box of an image (parts of its width and height, 0–1) while it is
 * moved or resized by a corner. It never leaves the image and never gets
 * smaller than MIN_CROP of a side.
 */

import type { Crop } from '@weldsuite/board-engine';

export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };
export const MIN_CROP = 0.05;

export type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `start` after dragging `handle` by (dx, dy), in parts of the image. */
export function dragCrop(start: Crop, handle: CropHandle, dx: number, dy: number): Crop {
  if (handle === 'move') return { x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h), w: start.w, h: start.h };
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle === 'nw' || handle === 'sw') left = clamp(start.x + dx, 0, right - MIN_CROP);
  if (handle === 'ne' || handle === 'se') right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle === 'nw' || handle === 'ne') top = clamp(start.y + dy, 0, bottom - MIN_CROP);
  if (handle === 'sw' || handle === 'se') bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The element height that keeps the kept part's proportions at the element's width. */
export function croppedHeight(width: number, crop: Crop, natural: { w: number; h: number }): number {
  const ratio = (crop.w * natural.w) / (crop.h * natural.h);
  return Math.max(10, Math.round(width / ratio));
}
