import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ZOOM_DURATION_MS,
  canZoomIn,
  canZoomOut,
  captureAnchor,
  clampZoom,
  easeOutCubic,
  scaleOf,
  scrollForAnchor,
  stepZoom,
  wheelZoomFactor,
  zoomBounds,
  type ZoomAnchor,
} from './model/zoom';

interface CanvasElements {
  /** The scrolling view around the pages. */
  scroller: () => HTMLElement | null;
  /** The first page. */
  page: () => HTMLElement | null;
}

export interface CanvasZoom {
  /** The zoom level drawn right now (moves smoothly during a zoom), in percent of the printed size. */
  shownPercent: number;
  /** The level being zoomed to. */
  targetPercent: number;
  fit: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: () => void;
  /** Ctrl/Cmd + wheel or trackpad pinch, centred on the pointer. */
  zoomWithWheel: (deltaY: number, deltaMode: number, clientX: number, clientY: number) => void;
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The designer's zoom: target level, a smooth glide to it, and the scroll
 * position that keeps the reader's place during the glide.
 *
 * A zoom takes its anchor once, when it starts, from what is on screen (the
 * pointer, the middle of the view, or the top when scrolled to the top). Every
 * frame of the glide then scrolls that same page point back to the same spot,
 * so nothing drifts, and a zoom that runs into a scroll limit picks up again
 * where it should when the next one starts.
 */
export function useCanvasZoom(fitPercent: number, elements: CanvasElements): CanvasZoom {
  const [target, setTarget] = useState<'fit' | number>('fit');
  const targetPercent = target === 'fit' ? fitPercent : target;
  const bounds = zoomBounds(fitPercent);

  const [shownPercent, setShownPercent] = useState(targetPercent);
  const shownRef = useRef(shownPercent);
  const anchorRef = useRef<ZoomAnchor | null>(null);
  const frameRef = useRef(0);
  const animatingRef = useRef(false);

  const stopAnimation = () => {
    cancelAnimationFrame(frameRef.current);
    animatingRef.current = false;
  };
  useEffect(() => stopAnimation, []);

  const geometry = useCallback(() => {
    const scroller = elements.scroller();
    const page = elements.page();
    if (!scroller || !page) return null;
    const view = scroller.getBoundingClientRect();
    const rect = page.getBoundingClientRect();
    return {
      scroller,
      // clientLeft/clientTop: the view's border, so offsets start inside it.
      pageLeft: rect.left - view.left - scroller.clientLeft,
      pageTop: rect.top - view.top - scroller.clientTop,
      viewLeft: view.left + scroller.clientLeft,
      viewTop: view.top + scroller.clientTop,
      viewWidth: scroller.clientWidth,
      viewHeight: scroller.clientHeight,
    };
  }, [elements]);

  /** Glide (or jump, with reduced motion) from the level on screen to `to`, keeping `anchor` in place. */
  const animateTo = useCallback((to: number, anchor: ZoomAnchor | null) => {
    stopAnimation();
    const from = shownRef.current;
    if (Math.abs(from - to) < 0.001) {
      anchorRef.current = null;
      return;
    }
    anchorRef.current = anchor;
    if (prefersReducedMotion()) {
      shownRef.current = to;
      setShownPercent(to);
      return;
    }
    animatingRef.current = true;
    const start = performance.now();
    const step = (now: number) => {
      const progress = (now - start) / ZOOM_DURATION_MS;
      const value = progress >= 1 ? to : from + (to - from) * easeOutCubic(progress);
      shownRef.current = value;
      setShownPercent(value);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else animatingRef.current = false;
    };
    frameRef.current = requestAnimationFrame(step);
  }, []);

  /** Start a zoom to `percent`, from what is on screen now. */
  const zoomTo = useCallback(
    (next: 'fit' | number, nextPercent: number, pointer?: { clientX: number; clientY: number }) => {
      const g = geometry();
      let anchor: ZoomAnchor | null = null;
      if (g) {
        // A button zoom while one is still gliding keeps that glide's anchor: re-measuring
        // mid-glide would pick up any distance a scroll limit kept it from covering.
        const keep = !pointer && animatingRef.current ? anchorRef.current : null;
        anchor =
          keep ??
          captureAnchor(
            { ...g, scrollTop: g.scroller.scrollTop, scale: scaleOf(shownRef.current) },
            pointer ? { x: pointer.clientX - g.viewLeft, y: pointer.clientY - g.viewTop } : undefined,
          );
      }
      setTarget(next);
      animateTo(nextPercent, anchor);
    },
    [animateTo, geometry],
  );

  // After every drawn level: scroll so the anchor's page point is back under its spot.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const g = geometry();
    if (!anchor || !g) return;
    const { left, top } = scrollForAnchor(anchor, {
      pageLeft: g.pageLeft,
      pageTop: g.pageTop,
      viewWidth: g.viewWidth,
      viewHeight: g.viewHeight,
      scale: scaleOf(shownPercent),
      scrollLeft: g.scroller.scrollLeft,
      scrollTop: g.scroller.scrollTop,
    });
    g.scroller.scrollLeft = left;
    g.scroller.scrollTop = top;
    if (!animatingRef.current) anchorRef.current = null;
  }, [shownPercent, geometry]);

  // The fitted level follows the canvas size; when fitting, a resize redraws at once without a glide.
  useEffect(() => {
    if (target !== 'fit' || animatingRef.current) return;
    shownRef.current = fitPercent;
    setShownPercent(fitPercent);
  }, [fitPercent, target]);

  // Latest values for the stable callbacks below.
  const live = useRef({ targetPercent, bounds, zoomTo });
  live.current = { targetPercent, bounds, zoomTo };

  const zoomIn = useCallback(() => {
    const { targetPercent: p, bounds: b, zoomTo: go } = live.current;
    if (canZoomIn(p, b)) {
      const next = stepZoom(p, 1, b);
      go(next, next);
    }
  }, []);

  const zoomOut = useCallback(() => {
    const { targetPercent: p, bounds: b, zoomTo: go } = live.current;
    if (canZoomOut(p, b)) {
      const next = stepZoom(p, -1, b);
      go(next, next);
    }
  }, []);

  const fitPercentRef = useRef(fitPercent);
  fitPercentRef.current = fitPercent;
  const zoomToFit = useCallback(() => {
    live.current.zoomTo('fit', fitPercentRef.current);
  }, []);

  const zoomWithWheel = useCallback((deltaY: number, deltaMode: number, clientX: number, clientY: number) => {
    const { targetPercent: p, bounds: b, zoomTo: go } = live.current;
    const next = clampZoom(p * wheelZoomFactor(deltaY, deltaMode), b);
    if (Math.abs(next - p) < 0.001) return;
    go(next, next, { clientX, clientY });
  }, []);

  return {
    shownPercent,
    targetPercent,
    fit: target === 'fit',
    canZoomIn: canZoomIn(targetPercent, bounds),
    canZoomOut: canZoomOut(targetPercent, bounds),
    zoomIn,
    zoomOut,
    zoomToFit,
    zoomWithWheel,
  };
}
