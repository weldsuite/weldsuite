/**
 * Drag-to-move behaviour for a fixed-position floating element.
 *
 * The position is remembered in localStorage per `storageKey`, and re-clamped
 * into view on mount and on resize — otherwise a chip parked at the right edge
 * of a wide monitor would be stranded off-screen on a laptop.
 *
 * Until the user drags it, no inline position is applied at all, so the caller
 * keeps full control of the default placement via CSS classes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface Position {
  x: number;
  y: number;
}

/** Distance the pointer must travel before it counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 3;
/** Keep at least this much of the element on screen when clamping. */
const EDGE_MARGIN_PX = 8;

function readStored(storageKey: string): Position | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Position>;
    if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    // Private mode, quota, or hand-edited junk — fall back to the default spot.
    return null;
  }
}

export function useDraggablePosition<T extends HTMLElement>(storageKey: string) {
  const ref = useRef<T | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Offset from the element's top-left to the pointer, so it doesn't jump.
  const grabOffset = useRef<Position>({ x: 0, y: 0 });
  const pointerStart = useRef<Position>({ x: 0, y: 0 });
  const passedThreshold = useRef(false);

  const clamp = useCallback((next: Position): Position => {
    const rect = ref.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const maxX = Math.max(EDGE_MARGIN_PX, window.innerWidth - width - EDGE_MARGIN_PX);
    const maxY = Math.max(EDGE_MARGIN_PX, window.innerHeight - height - EDGE_MARGIN_PX);
    return {
      x: Math.min(Math.max(next.x, EDGE_MARGIN_PX), maxX),
      y: Math.min(Math.max(next.y, EDGE_MARGIN_PX), maxY),
    };
  }, []);

  // Restore after first paint so the element has been measured and the stored
  // position can be clamped against its real size.
  useLayoutEffect(() => {
    const stored = readStored(storageKey);
    if (stored) setPosition(clamp(stored));
  }, [storageKey, clamp]);

  useEffect(() => {
    if (!position) return;
    const onResize = () => setPosition((current) => (current ? clamp(current) : current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [position, clamp]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<T>) => {
      // Let buttons, links and inputs handle their own pointer events — the
      // chip's controls must stay clickable.
      if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return;
      if (event.button !== 0) return;

      const rect = event.currentTarget.getBoundingClientRect();
      grabOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      pointerStart.current = { x: event.clientX, y: event.clientY };
      passedThreshold.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsDragging(true);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      if (!isDragging) return;
      if (!passedThreshold.current) {
        const dx = Math.abs(event.clientX - pointerStart.current.x);
        const dy = Math.abs(event.clientY - pointerStart.current.y);
        if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
        passedThreshold.current = true;
      }
      setPosition(
        clamp({
          x: event.clientX - grabOffset.current.x,
          y: event.clientY - grabOffset.current.y,
        }),
      );
    },
    [isDragging, clamp],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<T>) => {
      if (!isDragging) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setIsDragging(false);
      if (!passedThreshold.current) return;
      setPosition((current) => {
        if (current) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(current));
          } catch {
            // Not worth surfacing — the chip just won't remember where it was.
          }
        }
        return current;
      });
    },
    [isDragging, storageKey],
  );

  /** Reset to the caller's CSS-defined default placement. */
  const resetPosition = useCallback(() => {
    setPosition(null);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }, [storageKey]);

  return {
    ref,
    position,
    isDragging,
    resetPosition,
    /** Spread onto the draggable element. */
    dragHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    /** Inline style once moved; `undefined` while at the default position. */
    style: position
      ? ({ left: position.x, top: position.y, right: 'auto', bottom: 'auto' } as const)
      : undefined,
  };
}
