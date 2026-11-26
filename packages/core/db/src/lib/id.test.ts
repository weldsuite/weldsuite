import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId } from './id';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateId', () => {
  it('is the prefix, then the time and eight random characters in base 36', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const id = generateId('doc');
    expect(id).toMatch(/^doc_[0-9a-z]{16}$/);
    expect(id.slice(4, 12)).toBe((1_800_000_000_000).toString(36));
  });

  it('has no separator without a prefix', () => {
    expect(generateId()).toMatch(/^[0-9a-z]{16}$/);
  });

  it('fits the varchar(30) id columns with a prefix of up to 13 characters', () => {
    expect(generateId('ws').length).toBeLessThanOrEqual(30);
    expect(generateId('a'.repeat(13))).toHaveLength(30);
  });

  it('sorts by creation time', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_800_000_000_000);
    const earlier = generateId('fil');
    now.mockReturnValue(1_800_000_000_001);
    expect(generateId('fil') > earlier).toBe(true);
  });

  it('does not repeat itself within one millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const ids = new Set(Array.from({ length: 1000 }, () => generateId('x')));
    expect(ids.size).toBe(1000);
  });
});
