import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
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
} from './zoom';

const bounds = zoomBounds(100);

describe('zoom levels', () => {
  it('steps by 1.2 like the workflow canvas, between 50% and 200%', () => {
    expect(stepZoom(100, 1, bounds)).toBeCloseTo(120);
    expect(stepZoom(120, -1, bounds)).toBeCloseTo(100);
    expect(stepZoom(180, 1, bounds)).toBe(MAX_ZOOM);
    expect(stepZoom(55, -1, bounds)).toBe(MIN_ZOOM);
  });

  it('knows when it cannot go further', () => {
    expect(canZoomIn(MAX_ZOOM, bounds)).toBe(false);
    expect(canZoomOut(MIN_ZOOM, bounds)).toBe(false);
    expect(canZoomIn(100, bounds)).toBe(true);
    expect(canZoomOut(100, bounds)).toBe(true);
  });

  it('lets a fitted level below the minimum be the minimum, so zooming out never grows the page', () => {
    const small = zoomBounds(38);
    expect(small.min).toBe(38);
    expect(canZoomOut(38, small)).toBe(false);
    expect(stepZoom(38, 1, small)).toBeCloseTo(45.6);
    expect(clampZoom(10, small)).toBe(38);
  });

  it('turns a level into screen pixels per point (100% is the printed size)', () => {
    expect(scaleOf(100)).toBeCloseTo(96 / 72);
    expect(scaleOf(50)).toBeCloseTo(48 / 72);
  });
});

describe('wheel and pinch', () => {
  it('zooms in on wheel up and out on wheel down', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('keeps pinch steps small and caps a mouse-wheel notch near one button step', () => {
    expect(wheelZoomFactor(-2)).toBeLessThan(1.02);
    expect(wheelZoomFactor(-1000)).toBeCloseTo(wheelZoomFactor(-50));
    expect(wheelZoomFactor(-50)).toBeGreaterThan(1.2);
    expect(wheelZoomFactor(-50)).toBeLessThan(1.35);
  });

  it('reads line and page wheel units as pixels', () => {
    expect(wheelZoomFactor(-1, 1)).toBeCloseTo(wheelZoomFactor(-16));
    expect(wheelZoomFactor(-1, 2)).toBeCloseTo(wheelZoomFactor(-50));
  });

  it('is symmetric: in then out lands where it started', () => {
    expect(wheelZoomFactor(-7) * wheelZoomFactor(7)).toBeCloseTo(1);
  });
});

describe('easing', () => {
  it('runs from 0 to 1 without stepping backwards', () => {
    expect(easeOutCubic(-0.2)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(1.5)).toBe(1);
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });
});

/**
 * A scroll view of 800 x 600 with one page centred horizontally inside 40px
 * padding, like the canvas: lays the page out at a scale and clamps the scroll
 * the way a browser does.
 */
function simulate(scale: number, scrollLeft: number, scrollTop: number) {
  const view = { width: 800, height: 600 };
  const pad = 40;
  const page = { width: 595 * scale, height: 842 * scale };
  const contentWidth = Math.max(view.width, page.width + pad * 2);
  const contentHeight = page.height + pad * 2;
  const left = Math.min(Math.max(0, scrollLeft), contentWidth - view.width);
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, contentHeight - view.height));
  const pageContentLeft = (contentWidth - page.width) / 2;
  return {
    scrollLeft: left,
    scrollTop: top,
    pageLeft: pageContentLeft - left,
    pageTop: pad - top,
    viewWidth: view.width,
    viewHeight: view.height,
    scale,
  };
}

/** Zoom from one scale to another with an anchor, returning where the anchored page point ends up in the view. */
function zoom(fromScale: number, toScale: number, scrollTop: number, pointer?: { x: number; y: number }) {
  const before = simulate(fromScale, 0, scrollTop);
  const anchor = captureAnchor(before, pointer);
  const laidOut = simulate(toScale, before.scrollLeft, before.scrollTop);
  const scroll = scrollForAnchor(anchor, laidOut);
  const after = simulate(toScale, scroll.left, scroll.top);
  return { before, after, anchor };
}

describe('keeping the reader’s place', () => {
  it('keeps the top in view when zooming at the very top', () => {
    const { anchor, after } = zoom(scaleOf(100), scaleOf(150), 0);
    expect(anchor.pageY).toBeNull();
    expect(after.scrollTop).toBe(0);
  });

  it('keeps the point in the middle of the view in the middle once scrolled down', () => {
    const { before, after, anchor } = zoom(scaleOf(100), scaleOf(150), 300);
    const middleBefore = (before.viewHeight / 2 - before.pageTop) / before.scale;
    const middleAfter = (after.viewHeight / 2 - after.pageTop) / after.scale;
    expect(anchor.pageY).toBeCloseTo(middleBefore);
    expect(middleAfter).toBeCloseTo(middleBefore);
    // Horizontally too: what was in the middle of the view stays there as the page outgrows it.
    const centreBefore = (before.viewWidth / 2 - before.pageLeft) / before.scale;
    const centreAfter = (after.viewWidth / 2 - after.pageLeft) / after.scale;
    expect(anchor.pageX).toBeCloseTo(centreBefore);
    expect(centreAfter).toBeCloseTo(centreBefore);
  });

  it('keeps the point under the pointer under the pointer, even at the top', () => {
    const pointer = { x: 600, y: 450 };
    const { before, after } = zoom(scaleOf(100), scaleOf(170), 0, pointer);
    const under = (s: typeof before) => ({ x: (pointer.x - s.pageLeft) / s.scale, y: (pointer.y - s.pageTop) / s.scale });
    expect(under(after).x).toBeCloseTo(under(before).x);
    expect(under(after).y).toBeCloseTo(under(before).y);
  });

  it('stays exact over a whole animated zoom made of many small steps', () => {
    const anchorView = simulate(scaleOf(100), 0, 250);
    const anchor = captureAnchor(anchorView);
    let state = anchorView;
    for (let i = 1; i <= 12; i += 1) {
      const s = scaleOf(100 + (60 * easeOutCubic(i / 12)));
      const laidOut = simulate(s, state.scrollLeft, state.scrollTop);
      const scroll = scrollForAnchor(anchor, laidOut);
      state = simulate(s, scroll.left, scroll.top);
      expect((state.viewHeight / 2 - state.pageTop) / state.scale).toBeCloseTo(anchor.pageY ?? 0);
    }
  });

  it('keeps the middle in the middle when a scrollbar narrows the view mid-zoom', () => {
    const before = simulate(scaleOf(100), 0, 200);
    const anchor = captureAnchor(before);
    // The view loses 12px to a vertical scrollbar while the page grows.
    const laidOut = { ...simulate(scaleOf(150), before.scrollLeft, before.scrollTop), viewWidth: 788 };
    const scroll = scrollForAnchor(anchor, laidOut);
    const after = { ...simulate(scaleOf(150), scroll.left, scroll.top), viewWidth: 788 };
    expect((after.viewWidth / 2 - after.pageLeft) / after.scale).toBeCloseTo(anchor.pageX);
  });

  it('lets the browser clamp at the bottom instead of scrolling past the page', () => {
    const { after } = zoom(scaleOf(150), scaleOf(50), 10_000);
    expect(after.scrollTop).toBeGreaterThanOrEqual(0);
  });
});
