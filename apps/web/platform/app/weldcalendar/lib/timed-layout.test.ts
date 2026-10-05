import { describe, expect, it } from 'vitest';
import {
  layoutDayTimedEvents,
  layoutTimedColumns,
  timedBlockHorizontalStyle,
  timedBlockRange,
} from './timed-layout';
import { timedEventsForDay } from './event-days';

const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m);
const range = (from: [number, number], to: [number, number]) => ({ start: at(...from), end: at(...to) });

describe('layoutTimedColumns', () => {
  it('gives a lone event the full width', () => {
    expect(layoutTimedColumns([range([9, 0], [10, 0])])).toEqual([{ column: 0, columnCount: 1 }]);
  });

  it('keeps events that do not overlap at full width', () => {
    const result = layoutTimedColumns([range([9, 0], [10, 0]), range([10, 0], [11, 0]), range([13, 0], [14, 0])]);
    expect(result.every((p) => p.columnCount === 1 && p.column === 0)).toBe(true);
  });

  it('puts two simultaneous events side by side', () => {
    const result = layoutTimedColumns([range([9, 0], [10, 0]), range([9, 0], [10, 0])]);
    expect(result).toEqual([
      { column: 0, columnCount: 2 },
      { column: 1, columnCount: 2 },
    ]);
  });

  it('reuses a freed column inside the same cluster', () => {
    // A 9-12, B 9-10, C 10-11: C slides under B into column 1; cluster stays 2 wide.
    const result = layoutTimedColumns([range([9, 0], [12, 0]), range([9, 0], [10, 0]), range([10, 0], [11, 0])]);
    expect(result).toEqual([
      { column: 0, columnCount: 2 },
      { column: 1, columnCount: 2 },
      { column: 1, columnCount: 2 },
    ]);
  });

  it('opens a third column only when three events overlap at once', () => {
    const result = layoutTimedColumns([range([9, 0], [11, 0]), range([9, 30], [10, 30]), range([10, 0], [10, 45])]);
    expect(result.map((p) => p.column)).toEqual([0, 1, 2]);
    expect(result.every((p) => p.columnCount === 3)).toBe(true);
  });

  it('sizes clusters independently', () => {
    const result = layoutTimedColumns([
      range([9, 0], [10, 0]),
      range([9, 0], [10, 0]),
      range([15, 0], [16, 0]),
    ]);
    expect(result[0].columnCount).toBe(2);
    expect(result[2]).toEqual({ column: 0, columnCount: 1 });
  });

  it('returns placements in input order regardless of start order', () => {
    const result = layoutTimedColumns([range([11, 0], [12, 0]), range([9, 0], [10, 0]), range([9, 30], [10, 30])]);
    expect(result[0]).toEqual({ column: 0, columnCount: 1 });
    expect(result[1]).toEqual({ column: 0, columnCount: 2 });
    expect(result[2]).toEqual({ column: 1, columnCount: 2 });
  });

  it('puts the longer of two events that start together in the first column', () => {
    const result = layoutTimedColumns([range([9, 0], [9, 30]), range([9, 0], [11, 0])]);
    expect(result[1].column).toBe(0);
    expect(result[0].column).toBe(1);
  });

  it('treats a very short event as occupying the minimum block height', () => {
    // 9:00-9:05 drawn at least 30 minutes tall collides with a 9:20 event.
    const short = layoutTimedColumns([range([9, 0], [9, 5]), range([9, 20], [10, 0])], 30);
    expect(short.every((p) => p.columnCount === 2)).toBe(true);
    const plain = layoutTimedColumns([range([9, 0], [9, 5]), range([9, 20], [10, 0])], 0);
    expect(plain.every((p) => p.columnCount === 1)).toBe(true);
  });

  it('handles a zero-length event without throwing', () => {
    expect(layoutTimedColumns([range([9, 0], [9, 0]), range([9, 0], [9, 0])], 0)).toHaveLength(2);
  });

  it('returns nothing for no events', () => {
    expect(layoutTimedColumns([])).toEqual([]);
  });
});

describe('timedBlockRange', () => {
  it('uses the event itself and defaults to one hour without an end', () => {
    const r = timedBlockRange({ startTime: at(9, 0) });
    expect(r.end.getTime() - r.start.getTime()).toBe(60 * 60 * 1000);
  });

  it('uses the clipped segment for an event that crosses midnight', () => {
    const event = { startTime: new Date(2026, 9, 5, 22, 0), endTime: new Date(2026, 9, 6, 2, 0) };
    const [first] = timedEventsForDay([event], new Date(2026, 9, 5));
    const r = timedBlockRange(event, first.segment);
    expect(r.start).toEqual(at(22, 0));
    expect(r.end).toEqual(new Date(2026, 9, 6, 0, 0));
  });
});

describe('layoutDayTimedEvents', () => {
  it('lays two simultaneous segments side by side', () => {
    const events = [
      { startTime: at(9, 0), endTime: at(10, 0) },
      { startTime: at(9, 0), endTime: at(10, 0) },
    ];
    const items = timedEventsForDay(events, at(0));
    expect(layoutDayTimedEvents(items, 48).map((p) => p.columnCount)).toEqual([2, 2]);
  });
});

describe('timedBlockHorizontalStyle', () => {
  it('keeps the 3px gutters for a full-width block', () => {
    expect(timedBlockHorizontalStyle({ column: 0, columnCount: 1 })).toEqual({
      left: 'calc(0% + 3px)',
      width: 'calc(100% - 6px)',
    });
  });

  it('offsets later columns by their share of the width', () => {
    const style = timedBlockHorizontalStyle({ column: 1, columnCount: 2 });
    expect(style.left).toBe('calc(50% + 3px)');
    expect(style.width).toBe('calc(50% - 6px)');
  });
});
