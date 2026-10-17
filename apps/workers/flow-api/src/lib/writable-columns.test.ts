import { describe, expect, it } from 'vitest';
import { coerceTimestamps, pickWritable, PROJECT_WRITABLE_FIELDS } from './writable-columns';
import { containsPattern, escapeLikePattern } from './ilike-pattern';

describe('pickWritable', () => {
  it('keeps listed, defined keys only', () => {
    const out = pickWritable(
      { name: 'x', id: 'attacker', deletedAt: 'now', totalTasks: 9, description: undefined, color: null },
      PROJECT_WRITABLE_FIELDS,
    );
    expect(out).toEqual({ name: 'x', color: null });
  });
});

describe('coerceTimestamps', () => {
  it('turns ISO strings into Dates and leaves null / Date / absent fields alone', () => {
    const date = new Date('2030-01-01T00:00:00Z');
    const res = coerceTimestamps({ a: '2030-02-01T00:00:00.000Z', b: null, c: date, name: 'n' }, ['a', 'b', 'c', 'd']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.values.a).toEqual(new Date('2030-02-01T00:00:00.000Z'));
      expect(res.values.b).toBeNull();
      expect(res.values.c).toBe(date);
      expect(res.values.name).toBe('n');
      expect('d' in res.values).toBe(false);
    }
  });

  it('names the first invalid field', () => {
    expect(coerceTimestamps({ a: 'nope' }, ['a'])).toEqual({ ok: false, field: 'a' });
    expect(coerceTimestamps({ a: {} }, ['a'])).toEqual({ ok: false, field: 'a' });
  });
});

describe('ilike patterns', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLikePattern('50%_a\\b')).toBe('50\\%\\_a\\\\b');
    expect(containsPattern('a%')).toBe('%a\\%%');
  });
});
