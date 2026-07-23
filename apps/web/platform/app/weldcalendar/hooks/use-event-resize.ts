import { useState, useRef, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';

interface UseEventResizeOptions {
  hourHeight: number;
  onResize: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
}

export type ResizeEdge = 'top' | 'bottom';

export interface ResizeState {
  event: CalendarEvent;
  dayKey: string;
  topPx: number;
  heightPx: number;
}

export function useEventResize({ hourHeight, onResize }: UseEventResizeOptions) {
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const resizeRef = useRef<{
    event: CalendarEvent;
    dayKey: string;
    edge: ResizeEdge;
    originalTopPx: number;
    originalBottomPx: number;
    startMouseY: number;
  } | null>(null);
  const justResizedRef = useRef(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const hourHeightRef = useRef(hourHeight);
  hourHeightRef.current = hourHeight;

  const pendingCleanupRef = useRef<(() => void) | null>(null);

  const handleResizeStart = useCallback(
    (evt: CalendarEvent, edge: ResizeEdge, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startDate = new Date(evt.startTime);
      const endDate = evt.endTime
        ? new Date(evt.endTime)
        : new Date(startDate.getTime() + 3600000);
      const startHour = startDate.getHours() + startDate.getMinutes() / 60;
      const endHour = endDate.getHours() + endDate.getMinutes() / 60;
      const hh = hourHeightRef.current;
      const topPx = startHour * hh;
      const bottomPx = endHour * hh;

      resizeRef.current = {
        event: evt,
        dayKey: format(startDate, 'yyyy-MM-dd'),
        edge,
        originalTopPx: topPx,
        originalBottomPx: bottomPx,
        startMouseY: e.clientY,
      };

      const startY = e.clientY;

      pendingCleanupRef.current?.();

      const onMove = (me: MouseEvent) => {
        if (!resizeRef.current) return;
        const dy = me.clientY - startY;
        if (Math.abs(dy) > 3) {
          cleanup();
          const r = resizeRef.current;
          setResizeState({
            event: r.event,
            dayKey: r.dayKey,
            topPx: r.originalTopPx,
            heightPx: r.originalBottomPx - r.originalTopPx,
          });
        }
      };
      const onUp = () => {
        cleanup();
        resizeRef.current = null;
      };
      const cleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        pendingCleanupRef.current = null;
      };

      pendingCleanupRef.current = cleanup;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [],
  );

  // Active resize phase
  useEffect(() => {
    if (!resizeState) return;

    pendingCleanupRef.current?.();

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const hh = hourHeightRef.current;
      const r = resizeRef.current;
      const deltaY = e.clientY - r.startMouseY;
      const snap = hh / 4; // 15 minutes
      const minHeight = snap;

      if (r.edge === 'bottom') {
        const newBottom = Math.max(
          r.originalTopPx + minHeight,
          Math.min(r.originalBottomPx + deltaY, 24 * hh),
        );
        const snappedBottom = Math.round(newBottom / snap) * snap;
        setResizeState((prev) =>
          prev
            ? {
                ...prev,
                topPx: r.originalTopPx,
                heightPx: snappedBottom - r.originalTopPx,
              }
            : null,
        );
      } else {
        // top edge: move top, keep bottom fixed
        const newTop = Math.max(
          0,
          Math.min(r.originalTopPx + deltaY, r.originalBottomPx - minHeight),
        );
        const snappedTop = Math.round(newTop / snap) * snap;
        setResizeState((prev) =>
          prev
            ? {
                ...prev,
                topPx: snappedTop,
                heightPx: r.originalBottomPx - snappedTop,
              }
            : null,
        );
      }
    };

    const handleMouseUp = () => {
      if (resizeRef.current && resizeState) {
        const r = resizeRef.current;
        const hh = hourHeightRef.current;

        const startMinutes =
          Math.round(((resizeState.topPx / hh) * 60) / 15) * 15;
        const endMinutes =
          Math.round(
            (((resizeState.topPx + resizeState.heightPx) / hh) * 60) / 15,
          ) * 15;

        const newStart = new Date(r.dayKey + 'T00:00:00');
        newStart.setHours(
          Math.floor(startMinutes / 60),
          startMinutes % 60,
          0,
          0,
        );
        const newEnd = new Date(r.dayKey + 'T00:00:00');
        newEnd.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);

        const origStart = new Date(r.event.startTime);
        const origEnd = r.event.endTime
          ? new Date(r.event.endTime)
          : new Date(origStart.getTime() + 3600000);

        if (
          newStart.getTime() !== origStart.getTime() ||
          newEnd.getTime() !== origEnd.getTime()
        ) {
          onResizeRef.current(r.event, newStart, newEnd);
        }
      }
      justResizedRef.current = true;
      setTimeout(() => {
        justResizedRef.current = false;
      }, 50);
      resizeRef.current = null;
      setResizeState(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resizeRef.current = null;
        setResizeState(null);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [resizeState]);

  return {
    handleResizeStart,
    resizeState,
    isResizing: !!resizeState,
    justResizedRef,
  };
}
