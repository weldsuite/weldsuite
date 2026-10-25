/**
 * Field geometry for the editor. Fields are stored in PDF points of the page
 * as displayed (origin top-left); the editor draws pages at `scale` pixels per
 * point. Everything here is pure so it can be tested without a DOM.
 */

import {
  SIGN_FIELD_DEFAULT_SIZE,
  SIGN_MIN_FIELD_SIZE,
  type SignFieldType,
  type SignPageSize,
} from '@weldsuite/app-api-client/schemas/weldsign';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixels per point so a page of `pageWidth` points fills `containerWidth` pixels (capped at 2x). */
export function scaleFor(pageWidth: number, containerWidth: number): number {
  if (pageWidth <= 0 || containerWidth <= 0) return 1;
  return Math.min(containerWidth / pageWidth, 2);
}

/** Keep a box inside the page and at least the minimum size. */
export function clampBox(box: Box, page: SignPageSize): Box {
  const width = Math.min(Math.max(box.width, SIGN_MIN_FIELD_SIZE), page.width);
  const height = Math.min(Math.max(box.height, SIGN_MIN_FIELD_SIZE), page.height);
  return {
    x: Math.min(Math.max(box.x, 0), page.width - width),
    y: Math.min(Math.max(box.y, 0), page.height - height),
    width,
    height,
  };
}

/** A new field of `type`, centred on the point (in page points) where it was dropped. */
export function placeField(type: SignFieldType, at: { x: number; y: number }, page: SignPageSize): Box {
  const size = SIGN_FIELD_DEFAULT_SIZE[type];
  return round(clampBox({ x: at.x - size.width / 2, y: at.y - size.height / 2, ...size }, page));
}

/** Move a box by a screen delta (pixels), staying on the page. */
export function moveBox(box: Box, dxPx: number, dyPx: number, scale: number, page: SignPageSize): Box {
  return round(clampBox({ ...box, x: box.x + dxPx / scale, y: box.y + dyPx / scale }, page));
}

/** Resize a box from its bottom-right corner by a screen delta (pixels). */
export function resizeBox(box: Box, dxPx: number, dyPx: number, scale: number, page: SignPageSize): Box {
  const width = Math.min(Math.max(box.width + dxPx / scale, SIGN_MIN_FIELD_SIZE), page.width - box.x);
  const height = Math.min(Math.max(box.height + dyPx / scale, SIGN_MIN_FIELD_SIZE), page.height - box.y);
  return round({ ...box, width, height });
}

/** A point on the page (points) from a pointer position relative to the page's top-left corner (pixels). */
export function pointOnPage(offsetX: number, offsetY: number, scale: number): { x: number; y: number } {
  return { x: offsetX / scale, y: offsetY / scale };
}

/** Two decimals is far below what anyone can see, and keeps saved values tidy. */
function round(box: Box): Box {
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) };
}
