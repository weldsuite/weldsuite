import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { minuteFromPointer, useSlotDrag } from './use-slot-drag';

const HOUR = 48;
// Viewport Y of the scroll container's top edge (below the day headers).
const GRID_TOP = 150;

describe('minuteFromPointer', () => {
  it('maps the pointer to a minute in an unscrolled grid', () => {
    expect(minuteFromPointer(GRID_TOP, GRID_TOP, HOUR)).toBe(0);
    expect(minuteFromPointer(GRID_TOP + 8 * HOUR, GRID_TOP, HOUR)).toBe(8 * 60);
    expect(minuteFromPointer(GRID_TOP + 8.5 * HOUR, GRID_TOP, HOUR)).toBe(8 * 60 + 30);
  });

  it('maps the pointer to the slot under it in a scrolled grid', () => {
    // Scrolled 300px: the column's rect.top has moved up by the same amount,
    // so 8 AM now sits 300px higher on screen.
    const scrollTop = 300;
    const columnTop = GRID_TOP - scrollTop;
    const eightAmOnScreen = columnTop + 8 * HOUR;
    expect(minuteFromPointer(eightAmOnScreen, columnTop, HOUR)).toBe(8 * 60);
    expect(minuteFromPointer(eightAmOnScreen + HOUR / 4, columnTop, HOUR)).toBe(8 * 60 + 15);
  });

  it('snaps to 15 minutes', () => {
    expect(minuteFromPointer(GRID_TOP + (7 / 60) * HOUR, GRID_TOP, HOUR)).toBe(0);
    expect(minuteFromPointer(GRID_TOP + (8 / 60) * HOUR, GRID_TOP, HOUR)).toBe(15);
  });

  it('clamps to the day', () => {
    expect(minuteFromPointer(GRID_TOP - 100, GRID_TOP, HOUR)).toBe(0);
    expect(minuteFromPointer(GRID_TOP + 30 * HOUR, GRID_TOP, HOUR)).toBe(1440);
  });
});

describe('useSlotDrag', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Builds the week-grid DOM the hook walks: a scroll container holding a day
   * column. jsdom has no layout, so the column's rect is stubbed the way a
   * browser reports it: scrolling moves it up by `scrollTop`.
   */
  function mountGrid(scrollTop: number) {
    const scroller = document.createElement('div');
    scroller.className = 'overflow-y-auto';
    const col = document.createElement('div');
    col.dataset.dayCol = '2026-09-30';
    const cell = document.createElement('div');
    col.appendChild(cell);
    scroller.appendChild(col);
    document.body.appendChild(scroller);
    scroller.scrollTop = scrollTop;
    vi.spyOn(col, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, GRID_TOP - scrollTop, 100, 24 * HOUR),
    );
    return { cell, columnTop: GRID_TOP - scrollTop };
  }

  function clickAt(scrollTop: number, hourOnGrid: number) {
    const { cell, columnTop } = mountGrid(scrollTop);
    const onSelectSlot = vi.fn();
    const { result } = renderHook(() => useSlotDrag({ hourHeight: HOUR, onSelectSlot }));
    const clientY = columnTop + hourOnGrid * HOUR;
    const day = new Date(2026, 8, 30);

    act(() => {
      result.current.handleCellMouseDown(day, Math.floor(hourOnGrid), {
        button: 0,
        target: cell,
        currentTarget: cell,
        clientX: 50,
        clientY,
      } as unknown as React.MouseEvent);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY }));
    });

    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const [start, end, , wasDrag] = onSelectSlot.mock.calls[0];
    return { start: start as Date, end: end as Date, wasDrag: wasDrag as boolean };
  }

  it('creates the clicked slot in an unscrolled grid', () => {
    const { start, end, wasDrag } = clickAt(0, 8);
    expect(wasDrag).toBe(false);
    expect([start.getHours(), start.getMinutes()]).toEqual([8, 0]);
    expect([end.getHours(), end.getMinutes()]).toEqual([9, 0]);
  });

  it('creates the clicked slot in a scrolled grid', () => {
    // Regression: scrollTop used to be added on top of the scrolled rect, so
    // with 300px of scroll an 8 AM click landed at 2:15 PM.
    const { start, end } = clickAt(300, 8);
    expect([start.getHours(), start.getMinutes()]).toEqual([8, 0]);
    expect([end.getHours(), end.getMinutes()]).toEqual([9, 0]);
  });

  it('creates the dragged range in a scrolled grid', () => {
    const { cell, columnTop } = mountGrid(300);
    const onSelectSlot = vi.fn();
    const { result } = renderHook(() => useSlotDrag({ hourHeight: HOUR, onSelectSlot }));
    const yAt = (hour: number) => columnTop + hour * HOUR;

    act(() => {
      result.current.handleCellMouseDown(new Date(2026, 8, 30), 8, {
        button: 0,
        target: cell,
        currentTarget: cell,
        clientX: 50,
        clientY: yAt(8),
      } as unknown as React.MouseEvent);
    });
    // First move crosses the drag threshold (pending phase), the second runs
    // through the dragging-phase listener.
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: yAt(9) }));
    });
    expect(result.current.slotSelection?.endTime.getHours()).toBe(9);
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: yAt(10.5) }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: yAt(10.5) }));
    });

    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const [start, end, , wasDrag] = onSelectSlot.mock.calls[0];
    expect(wasDrag).toBe(true);
    expect([start.getHours(), start.getMinutes()]).toEqual([8, 0]);
    expect([end.getHours(), end.getMinutes()]).toEqual([10, 30]);
  });
});
