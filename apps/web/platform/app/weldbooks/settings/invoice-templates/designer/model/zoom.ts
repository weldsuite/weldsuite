/**
 * Zoom maths for the designer canvas, kept free of the DOM so it can be tested.
 * Levels follow the workflow canvas (React Flow): a button press zooms by 1.2,
 * between 50% and 200% of the printed size.
 */

/** 96 dpi screen pixels per PDF point: 100% shows the page at its printed size. */
export const PX_PER_PT = 96 / 72;

/** Screen pixels per page point at a zoom level. */
export function scaleOf(percent: number): number {
  return (percent / 100) * PX_PER_PT;
}

export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;
export const ZOOM_FACTOR = 1.2;

/** Animation length of a zoom step, in milliseconds. */
export const ZOOM_DURATION_MS = 180;

/** Below this difference two zoom levels count as the same. */
const EPSILON = 0.01;

export interface ZoomBounds {
  min: number;
  max: number;
}

/**
 * The allowed range. Fitting a big page into a small canvas can need less than
 * the usual minimum; then that fitted level is the minimum, so zooming out never
 * makes the page bigger.
 */
export function zoomBounds(fitPercent: number): ZoomBounds {
  return { min: Math.min(MIN_ZOOM, fitPercent), max: MAX_ZOOM };
}

export function clampZoom(percent: number, bounds: ZoomBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, percent));
}

/** One button press: zoom in (+1) or out (-1) by the zoom factor. */
export function stepZoom(percent: number, direction: 1 | -1, bounds: ZoomBounds): number {
  return clampZoom(percent * ZOOM_FACTOR ** direction, bounds);
}

export function canZoomIn(percent: number, bounds: ZoomBounds): boolean {
  return percent < bounds.max - EPSILON;
}

export function canZoomOut(percent: number, bounds: ZoomBounds): boolean {
  return percent > bounds.min + EPSILON;
}

/** Largest wheel movement, in pixels, that one event counts for: a fast flick of a mouse wheel stays one smooth step. */
const MAX_WHEEL_PX = 50;

/**
 * Zoom multiplier for one Ctrl/Cmd + wheel event (or trackpad pinch, which the
 * browser reports the same way). Small pinch deltas give small, smooth changes;
 * one mouse-wheel notch gives about one button step.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  // deltaMode 1 counts lines and 2 pages; turn both into pixels.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
  const clamped = Math.max(-MAX_WHEEL_PX, Math.min(MAX_WHEEL_PX, px));
  return 2 ** (-clamped * 0.0075);
}

/** Ease-out: fast start, gentle landing. */
export function easeOutCubic(t: number): number {
  const p = Math.min(1, Math.max(0, t));
  return 1 - (1 - p) ** 3;
}

/** Where a zoom is centred: a point on the page that stays at the same spot in the view. */
export interface ZoomAnchor {
  /** Spot in the view (pixels from its top-left corner) that the page point stays under. */
  viewX: number;
  viewY: number;
  /** The page point, in unscaled page units (points). */
  pageX: number;
  /** Null: the view is at the very top and stays there. */
  pageY: number | null;
  /**
   * Anchored to the middle of the view rather than a pointer: the middle is
   * measured again on every frame, so a scrollbar appearing or going (which
   * changes the view's size) does not shift the page sideways.
   */
  centred: boolean;
}

export interface ZoomGeometry {
  /** Page's top-left corner relative to the view's top-left corner, in pixels. */
  pageLeft: number;
  pageTop: number;
  /** Visible size of the view, scrollbars excluded. */
  viewWidth: number;
  viewHeight: number;
  scrollTop: number;
  /** Screen pixels per page point. */
  scale: number;
}

/**
 * The anchor for a zoom that starts now. With a pointer (wheel or pinch) the
 * point under the pointer stays put; otherwise the middle of the view does,
 * except at the very top of the canvas, where the top stays in view.
 */
export function captureAnchor(geometry: ZoomGeometry, pointer?: { x: number; y: number }): ZoomAnchor {
  const { pageLeft, pageTop, viewWidth, viewHeight, scrollTop, scale } = geometry;
  const viewX = pointer?.x ?? viewWidth / 2;
  const viewY = pointer?.y ?? viewHeight / 2;
  const atTop = !pointer && scrollTop <= 0;
  return {
    viewX,
    viewY,
    pageX: (viewX - pageLeft) / scale,
    pageY: atTop ? null : (viewY - pageTop) / scale,
    centred: !pointer,
  };
}

/**
 * Scroll offsets that put the anchor's page point back under its spot in the
 * view, once the page is drawn at the new scale. `pageLeft`/`pageTop` are
 * measured at the new scale; the browser clamps offsets it cannot reach.
 */
export function scrollForAnchor(
  anchor: ZoomAnchor,
  geometry: Omit<ZoomGeometry, 'scrollTop'> & { scrollLeft: number; scrollTop: number },
): { left: number; top: number } {
  const { pageLeft, pageTop, scale, scrollLeft, scrollTop } = geometry;
  const viewX = anchor.centred ? geometry.viewWidth / 2 : anchor.viewX;
  const viewY = anchor.centred ? geometry.viewHeight / 2 : anchor.viewY;
  // Page position in scroll-content coordinates.
  const contentLeft = pageLeft + scrollLeft;
  const contentTop = pageTop + scrollTop;
  return {
    left: contentLeft + anchor.pageX * scale - viewX,
    top: anchor.pageY === null ? 0 : contentTop + anchor.pageY * scale - viewY,
  };
}
