import { formatTaskNumber, joinSubtitle } from '@/lib/task-number';

describe('formatTaskNumber', () => {
  it('renders the bare number', () => {
    expect(formatTaskNumber(1042)).toBe('1042');
  });

  it('returns undefined for tasks without a number', () => {
    expect(formatTaskNumber(null)).toBeUndefined();
    expect(formatTaskNumber(undefined)).toBeUndefined();
  });
});

describe('joinSubtitle', () => {
  it('joins the parts that are present', () => {
    expect(joinSubtitle('12', 'Website')).toBe('12 · Website');
    expect(joinSubtitle(undefined, 'Website')).toBe('Website');
    expect(joinSubtitle('12', null)).toBe('12');
  });

  it('returns undefined when nothing is present', () => {
    expect(joinSubtitle(undefined, null, '')).toBeUndefined();
  });
});
