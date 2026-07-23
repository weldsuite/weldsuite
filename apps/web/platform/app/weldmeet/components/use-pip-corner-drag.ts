import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/**
 * Drag-to-corner behaviour for the minimized meeting (PiP) widget.
 *
 * Design notes:
 * - The RESTING position stays corner-anchored via plain CSS insets
 *   (top/bottom/left/right). That means window resize, a side panel opening
 *   (`rightInset`), or the widget's own height changing all keep it pinned to
 *   the corner for free — no JS recomputation, no drift.
 * - While DRAGGING we apply a `transform: translate()` on top of the resting
 *   anchor, so the layout never reflows and the motion is buttery.
 * - On release we animate that same transform to the nearest corner, then
 *   (after the transition) commit the new corner and clear the transform — the
 *   final frame is pixel-identical, so the swap is invisible. Smooth snap,
 *   robust resting state.
 * - The chosen corner is persisted, so it survives navigation and reloads.
 */
export type PipCorner = 'tl' | 'tr' | 'bl' | 'br';

const STORAGE_KEY = 'weldmeet-pip-corner';
const MARGIN = 16; // matches the old `bottom-4 right-4` (1rem)
const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag
const SNAP_MS = 220;

function readCorner(): PipCorner {
  if (typeof window === 'undefined') return 'br';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'tl' || v === 'tr' || v === 'bl' || v === 'br') return v;
  } catch {
    /* ignore */
  }
  return 'br';
}

/** Top-left viewport pixel the widget occupies when anchored to `corner`. */
function cornerTopLeft(
  corner: PipCorner,
  w: number,
  h: number,
  rightInset: number,
): { left: number; top: number } {
  const left =
    corner === 'tl' || corner === 'bl'
      ? MARGIN
      : Math.max(MARGIN, window.innerWidth - w - rightInset);
  const top =
    corner === 'tl' || corner === 'tr'
      ? MARGIN
      : Math.max(MARGIN, window.innerHeight - h - MARGIN);
  return { left, top };
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  baseLeft: number; // mathematical resting top-left of the current corner
  baseTop: number;
  // Visual minus resting at grab time — i.e. any transform still in flight
  // (entrance animation or an interrupted snap). Keeps the grab glitch-free.
  startOffX: number;
  startOffY: number;
  w: number;
  h: number;
  moved: boolean;
}

export function usePipCornerDrag(
  ref: RefObject<HTMLDivElement | null>,
  opts: { panelWidth: number; enabled: boolean },
) {
  const { panelWidth, enabled } = opts;
  const rightInset = panelWidth + MARGIN;

  const [corner, setCorner] = useState<PipCorner>(readCorner);
  // Live transform offset (px) during drag/snap. null === resting.
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const [snapping, setSnapping] = useState(false);
  const drag = useRef<DragState | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True for the click that immediately follows a real drag, so the widget's
   *  click-to-expand handler can ignore it. */
  const didDragRef = useRef(false);

  const clampTopLeft = (left: number, top: number, w: number, h: number) => ({
    left: Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN)),
  });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Every press resets the drag flag — including presses on controls, so a
      // later deliberate click (e.g. a dropdown item) is never mistaken for the
      // tail of an earlier drag.
      didDragRef.current = false;
      if (!enabled) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const el = ref.current;
      if (!el) return;
      // Don't hijack presses that belong to interactive controls.
      const target = e.target as HTMLElement;
      if (target.closest('button, a, input, select, textarea, [role="menuitem"], [data-no-drag]')) {
        return;
      }
      if (snapTimer.current) {
        clearTimeout(snapTimer.current);
        snapTimer.current = null;
      }
      const rect = el.getBoundingClientRect();
      const resting = cornerTopLeft(corner, rect.width, rect.height, rightInset);
      drag.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseLeft: resting.left,
        baseTop: resting.top,
        startOffX: rect.left - resting.left,
        startOffY: rect.top - resting.top,
        w: rect.width,
        h: rect.height,
        moved: false,
      };
    },
    [enabled, ref, corner, rightInset],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.moved = true;
        didDragRef.current = true;
        setSnapping(false);
        ref.current?.setPointerCapture(d.pointerId);
      }
      const { left, top } = clampTopLeft(
        d.baseLeft + d.startOffX + dx,
        d.baseTop + d.startOffY + dy,
        d.w,
        d.h,
      );
      setOffset({ x: left - d.baseLeft, y: top - d.baseTop });
    },
    [ref],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      ref.current?.releasePointerCapture?.(e.pointerId);
      if (!d.moved) {
        setOffset(null);
        return;
      }
      // Nearest corner from the widget's current center.
      const { left, top } = clampTopLeft(
        d.baseLeft + d.startOffX + (e.clientX - d.startX),
        d.baseTop + d.startOffY + (e.clientY - d.startY),
        d.w,
        d.h,
      );
      const cx = left + d.w / 2;
      const cy = top + d.h / 2;
      const horiz = cx < window.innerWidth / 2 ? 'l' : 'r';
      const vert = cy < window.innerHeight / 2 ? 't' : 'b';
      const next = `${vert}${horiz}` as PipCorner;

      // Animate the transform from where we are to the target corner, then
      // commit (anchor swap is invisible because the final frame matches).
      const targetTopLeft = cornerTopLeft(next, d.w, d.h, rightInset);
      setSnapping(true);
      setOffset({ x: targetTopLeft.left - d.baseLeft, y: targetTopLeft.top - d.baseTop });
      snapTimer.current = setTimeout(() => {
        snapTimer.current = null;
        setCorner(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* ignore */
        }
        setOffset(null);
        setSnapping(false);
      }, SNAP_MS);
    },
    [ref, rightInset],
  );

  const restingInset: CSSProperties =
    corner === 'tl'
      ? { top: MARGIN, left: MARGIN }
      : corner === 'tr'
        ? { top: MARGIN, right: rightInset }
        : corner === 'bl'
          ? { bottom: MARGIN, left: MARGIN }
          : { bottom: MARGIN, right: rightInset };

  const style: CSSProperties = {
    ...restingInset,
    transform: offset ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
    transition: snapping
      ? `transform ${SNAP_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
      : offset
        ? 'none'
        : undefined,
    touchAction: 'none',
  };

  return {
    style,
    isDragging: !!offset && !snapping,
    didDragRef,
    // `onPointerCancel` reuses the release path so an interrupted drag (e.g. a
    // touch cancelled by the OS) still snaps to a corner instead of sticking.
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
