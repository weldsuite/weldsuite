/**
 * A dashboard chart's tooltip, attached to the pointer.
 *
 * Recharts places its tooltip from the hovered data point and eases every move
 * over 400ms, so it trails the pointer, hops from point to point and can land
 * on top of the pointer in a narrow chart. This one follows the pointer itself:
 *
 * - It is moved on every mouse move straight from the event (a style write,
 *   no React render, no easing), so it stays glued to the pointer.
 * - It sits 16px beside the pointer, vertically centred on it, so it never
 *   covers the pointer: to the right in the chart's left half, to the left in
 *   its right half, flipping only when the window edge is in the way.
 * - It is portalled to the page with fixed positioning, so a narrow card never
 *   squeezes it on top of the chart.
 *
 * The content still snaps to the nearest month; the cursor line marks it. From
 * the keyboard (no pointer) it sits beside the active point instead.
 *
 * Spread `FOLLOWING_TOOLTIP_PROPS` on the `<Tooltip />` and render the content
 * inside `<FollowingTooltip>` from a `content` function, which hands it the
 * active state and coordinate.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Space between the pointer and the tooltip's near edge. */
const OFFSET = 16;
/** Closest the tooltip comes to the window's edges. */
const MARGIN = 8;

/** Turns off Recharts' own placement and easing; `FollowingTooltip` places the content. */
export const FOLLOWING_TOOLTIP_PROPS = {
  isAnimationActive: false,
  position: { x: 0, y: 0 },
  allowEscapeViewBox: { x: true, y: true },
} as const;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function FollowingTooltip({
  active,
  coordinate,
  children,
}: Readonly<{ active?: boolean; coordinate?: { x?: number; y?: number }; children: ReactNode }>) {
  // Stays inside the chart, so the tooltip can find the chart it belongs to.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  /** The pointer in window coordinates, while it is over the chart. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const latestCoordinate = useRef(coordinate);
  // The widest it has been, held as its min width so it keeps one size as the month names change.
  const minWidth = useRef(0);

  const place = useCallback(() => {
    const tooltip = tooltipRef.current;
    const chart = anchorRef.current?.closest<HTMLElement>('.recharts-wrapper');
    if (!tooltip || !chart) return;
    const bounds = chart.getBoundingClientRect();
    const point = latestCoordinate.current;
    const target =
      pointer.current ??
      (typeof point?.x === 'number' ? { x: bounds.left + point.x, y: bounds.top + (point.y ?? bounds.height / 2) } : null);
    if (!target) return;

    if (tooltip.offsetWidth > minWidth.current) {
      minWidth.current = tooltip.offsetWidth;
      tooltip.style.minWidth = `${minWidth.current}px`;
    }
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;

    const right = target.x + OFFSET;
    const left = target.x - OFFSET - width;
    const preferLeft = target.x > bounds.left + bounds.width / 2;
    const fits = (x: number) => x >= MARGIN && x + width <= viewWidth - MARGIN;
    let x = preferLeft ? left : right;
    if (!fits(x)) x = preferLeft ? right : left;
    x = clamp(x, MARGIN, viewWidth - MARGIN - width);
    const y = clamp(target.y - height / 2, MARGIN, viewHeight - MARGIN - height);
    tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }, []);

  useEffect(() => {
    const chart = anchorRef.current?.closest<HTMLElement>('.recharts-wrapper');
    if (!chart) return;
    const move = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      place();
    };
    const leave = () => {
      pointer.current = null;
    };
    chart.addEventListener('mousemove', move);
    chart.addEventListener('mouseleave', leave);
    return () => {
      chart.removeEventListener('mousemove', move);
      chart.removeEventListener('mouseleave', leave);
    };
  }, [place]);

  // New rows can change the size: place again before the browser paints.
  useLayoutEffect(() => {
    latestCoordinate.current = coordinate;
    if (active) place();
  });

  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(
        <div
          ref={tooltipRef}
          aria-hidden={!active}
          className="pointer-events-none fixed top-0 left-0 z-50 transition-opacity duration-100 motion-reduce:transition-none"
          style={{ opacity: active ? 1 : 0 }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
