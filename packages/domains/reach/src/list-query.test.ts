import { describe, expect, it } from 'vitest';
import { likePattern, pageOf, pageResult, parseLimit } from './list-query';

describe('parseLimit', () => {
  it('defaults to 25, caps at 100 and ignores nonsense', () => {
    expect(parseLimit(undefined)).toBe(25);
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit(10)).toBe(10);
    expect(parseLimit('500')).toBe(100);
    expect(parseLimit('0')).toBe(25);
    expect(parseLimit('-3')).toBe(25);
    expect(parseLimit('abc')).toBe(25);
  });
});

describe('likePattern', () => {
  it('escapes LIKE wildcards in typed text', () => {
    expect(likePattern('  100%_off\\ ')).toBe('%100\\%\\_off\\\\%');
  });
});

describe('pageOf / pageResult', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('trims the probe row and points the cursor at the last row kept', () => {
    expect(pageOf(rows, 2)).toEqual({ data: [{ id: 'a' }, { id: 'b' }], hasMore: true, nextCursor: 'b' });
    expect(pageOf(rows, 3)).toEqual({ data: rows, hasMore: false, nextCursor: null });
  });

  it('maps rows to DTOs and carries the total as a number', () => {
    expect(pageResult(rows, 2, '7', (r) => r.id.toUpperCase())).toEqual({
      data: ['A', 'B'],
      totalCount: 7,
      hasMore: true,
      cursor: 'b',
    });
  });
});
