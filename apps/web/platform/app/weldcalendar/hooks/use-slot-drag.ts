import { useState, useRef, useEffect, useCallback } from 'react';
import { format } from 'date-fns';

interface UseSlotDragOptions {
  hourHeight: number;
  // `wasDrag` is true when the user dragged a range (>5px movement) and false
  // for a plain click. Consumers use it to distinguish click-to-create from
  // drag-to-create — relevant when a popover is already open and we want a
  // single click to dismiss but a drag to switch to the new range.
  onSelectSlot: (start: Date, end: Date, mouseEvent: MouseEvent, wasDrag: boolean) => void;
}

interface SlotSelection {
  dayKey: string;
  topPx: number;
  heightPx: number;
  startTime: Date;
  endTime: Date;
}

interface SlotDragResult {
  handleCellMouseDown: (day: Date, hour: number, e: React.MouseEvent) => void;
  isSlotDragging: boolean;
  slotSelection: SlotSelection | null;
}

function minutesToDate(day: Date, minutes: number): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function snapTo15(minutes: number): number {
  return Math.round(minutes / 15) * 15;
}

function clampMinutes(minutes: number): number {
  return Math.max(0, Math.min(1440, minutes));
}

export function useSlotDrag({ hourHeight, onSelectSlot }: UseSlotDragOptions): SlotDragResult {
  const [dragState, setDragState] = useState<{
    day: Date;
    dayKey: string;
    startMinute: number;
    endMinute: number;
  } | null>(null);

  const onSelectSlotRef = useRef(onSelectSlot);
  onSelectSlotRef.current = onSelectSlot;
  const hourHeightRef = useRef(hourHeight);
  hourHeightRef.current = hourHeight;

  // Cleanup ref for pending listeners
  const pendingCleanupRef = useRef<(() => void) | null>(null);

  const handleCellMouseDown = useCallback((day: Date, hour: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't start slot drag if mousedown is on an event button
    if ((e.target as HTMLElement).closest('button')) return;

    const col = (e.currentTarget as HTMLElement).closest('[data-day-col]') as HTMLElement;
    if (!col) return;

    const scrollContainer = col.closest('.overflow-y-auto') as HTMLElement;
    const colRect = col.getBoundingClientRect();
    const scrollTop = scrollContainer?.scrollTop || 0;
    const hh = hourHeightRef.current;

    // Compute precise minute from mouse Y within the column
    const relativeY = e.clientY - colRect.top + scrollTop;
    const startMinute = snapTo15(clampMinutes((relativeY / hh) * 60));

    const dayKey = format(day, 'yyyy-MM-dd');
    const startX = e.clientX;
    const startY = e.clientY;
    const columnTop = colRect.top;

    // Clean up any previous pending listeners
    pendingCleanupRef.current?.();

    // Attach pending listeners directly (no reliance on useEffect re-render)
    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) {
        // Promote to drag
        cleanup();
        const colNow = document.querySelector(`[data-day-col="${dayKey}"]`) as HTMLElement;
        const scrollNow = colNow?.closest('.overflow-y-auto') as HTMLElement;
        const colRectNow = colNow?.getBoundingClientRect();
        const scrollTopNow = scrollNow?.scrollTop || 0;
        const relY = me.clientY - (colRectNow?.top || columnTop) + scrollTopNow;
        const endMinute = snapTo15(clampMinutes((relY / hourHeightRef.current) * 60));

        setDragState({
          day,
          dayKey,
          startMinute,
          endMinute,
        });
      }
    };

    const onUp = (me: MouseEvent) => {
      // Click case: no drag threshold reached — fire 1-hour slot
      cleanup();
      const start = minutesToDate(day, startMinute);
      const end = minutesToDate(day, startMinute + 60);
      onSelectSlotRef.current(start, end, me, false);
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      pendingCleanupRef.current = null;
    };

    pendingCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // Dragging phase
  useEffect(() => {
    if (!dragState) return;

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    // Clean up any leftover pending listeners
    pendingCleanupRef.current?.();

    const handleMouseMove = (e: MouseEvent) => {
      const hh = hourHeightRef.current;
      const col = document.querySelector(`[data-day-col="${dragState.dayKey}"]`) as HTMLElement;
      if (!col) return;
      const scrollContainer = col.closest('.overflow-y-auto') as HTMLElement;
      const colRect = col.getBoundingClientRect();
      const scrollTop = scrollContainer?.scrollTop || 0;
      const relativeY = e.clientY - colRect.top + scrollTop;
      const endMinute = snapTo15(clampMinutes((relativeY / hh) * 60));
      setDragState((prev) => prev ? { ...prev, endMinute } : null);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (dragState) {
        const lo = Math.min(dragState.startMinute, dragState.endMinute);
        let hi = Math.max(dragState.startMinute, dragState.endMinute);
        // Minimum 15 minutes
        if (hi - lo < 15) hi = lo + 15;
        const start = minutesToDate(dragState.day, lo);
        const end = minutesToDate(dragState.day, Math.min(hi, 1440));
        onSelectSlotRef.current(start, end, e, true);
      }
      setDragState(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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

  // Compute selection preview
  const slotSelection: SlotSelection | null = dragState
    ? (() => {
        const hh = hourHeightRef.current;
        const lo = Math.min(dragState.startMinute, dragState.endMinute);
        const hi = Math.max(dragState.startMinute, dragState.endMinute);
        const effectiveHi = hi - lo < 15 ? lo + 15 : hi;
        return {
          dayKey: dragState.dayKey,
          topPx: (lo / 60) * hh,
          heightPx: Math.max(((effectiveHi - lo) / 60) * hh, hh / 4),
          startTime: minutesToDate(dragState.day, lo),
          endTime: minutesToDate(dragState.day, Math.min(effectiveHi, 1440)),
        };
      })()
    : null;

  return {
    handleCellMouseDown,
    isSlotDragging: !!dragState,
    slotSelection,
  };
}
