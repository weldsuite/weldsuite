import { formatTaskNumber, joinSubtitle } from '@/lib/task-number';

describe('formatTaskNumber', () => {
  it('prefixes the raw number', () => {
    expect(formatTaskNumber(1042)).toBe('TASK-1042');
  });

  it('returns undefined for tasks without a number', () => {
    expect(formatTaskNumber(null)).toBeUndefined();
    expect(formatTaskNumber(undefined)).toBeUndefined();
  });
});

describe('joinSubtitle', () => {
  it('joins the parts that are present', () => {
    expect(joinSubtitle('TASK-12', 'Website')).toBe('TASK-12 · Website');
    expect(joinSubtitle(undefined, 'Website')).toBe('Website');
    expect(joinSubtitle('TASK-12', null)).toBe('TASK-12');
  });

  it('returns undefined when nothing is present', () => {
    expect(joinSubtitle(undefined, null, '')).toBeUndefined();
  });
});
