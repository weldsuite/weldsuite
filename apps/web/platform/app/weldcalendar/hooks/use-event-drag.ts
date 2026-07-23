import { useState, useRef, useEffect, useCallback } from 'react';
import { format, differenceInMinutes } from 'date-fns';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';

interface UseEventDragOptions {
  hourHeight: number;
  onDrop: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
}

export interface DragState {
  event: CalendarEvent;
  ghostTop: number;
  ghostDayKey: string;
  duration: number;
}

export function useEventDrag({ hourHeight, onDrop }: UseEventDragOptions) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<{
    event: CalendarEvent;
    startMouseY: number;
    startTopPx: number;
    duration: number;
    originDayKey: string;
  } | null>(null);
  const justDraggedRef = useRef(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const hourHeightRef = useRef(hourHeight);
  hourHeightRef.current = hourHeight;

  const pendingCleanupRef = useRef<(() => void) | null>(null);

  const handleDragStart = useCallback(
    (evt: CalendarEvent, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startDate = new Date(evt.startTime);
      const endDate = evt.endTime
        ? new Date(evt.endTime)
        : new Date(startDate.getTime() + 3600000);
      const hh = hourHeightRef.current;
      const startHour = startDate.getHours() + startDate.getMinutes() / 60;
      const duration = differenceInMinutes(endDate, startDate);
      const originDayKey = format(startDate, 'yyyy-MM-dd');

      dragRef.current = {
        event: evt,
        startMouseY: e.clientY,
        startTopPx: startHour * hh,
        duration,
        originDayKey,
      };

      const startX = e.clientX;
      const startY = e.clientY;

      pendingCleanupRef.current?.();

      const onMove = (me: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 5) {
          cleanup();
          const r = dragRef.current;
          setDragState({
            event: r.event,
            ghostTop: r.startTopPx,
            ghostDayKey: r.originDayKey,
            duration: r.duration,
          });
        }
      };
      const onUp = () => {
        cleanup();
        dragRef.current = null;
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

  // Active drag phase
  useEffect(() => {
    if (!dragState) return;

    pendingCleanupRef.current?.();

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const hh = hourHeightRef.current;
      const deltaY = e.clientY - dragRef.current.startMouseY;
      const newTop = Math.max(
        0,
        Math.min(dragRef.current.startTopPx + deltaY, 24 * hh - 12),
      );
      const snappedTop = Math.round(newTop / (hh / 4)) * (hh / 4);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest('[data-day-col]') as HTMLElement;
      const dayKey = col?.dataset.dayCol || dragRef.current.originDayKey;
      setDragState((prev) =>
        prev ? { ...prev, ghostTop: snappedTop, ghostDayKey: dayKey } : null,
      );
    };

    const handleMouseUp = () => {
      if (dragRef.current && dragState) {
        const hh = hourHeightRef.current;
        const hours = Math.floor(dragState.ghostTop / hh);
        const minutes =
          Math.round(((dragState.ghostTop % hh) / hh) * 60 / 15) * 15;
        const newStart = new Date(dragState.ghostDayKey + 'T00:00:00');
        newStart.setHours(hours, minutes, 0, 0);
        const newEnd = new Date(
          newStart.getTime() + dragState.duration * 60000,
        );
        const origStart = new Date(dragRef.current.event.startTime);
        if (newStart.getTime() !== origStart.getTime()) {
          onDropRef.current(dragRef.current.event, newStart, newEnd);
        }
      }
      justDraggedRef.current = true;
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 50);
      dragRef.current = null;
      setDragState(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragRef.current = null;
        setDragState(null);
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
  }, [dragState]);

  return {
    handleDragStart,
    dragState,
    isDragging: !!dragState,
    justDraggedRef,
  };
}
