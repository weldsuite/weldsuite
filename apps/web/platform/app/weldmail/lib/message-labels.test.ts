import { describe, expect, it } from 'vitest';
import { hasLabel, userLabelsOf, withLabel, withoutLabel } from './message-labels';

describe('message labels', () => {
  it('finds a system label whatever its casing', () => {
    expect(hasLabel(['SPAM'], 'spam')).toBe(true);
    expect(hasLabel(['spam'], 'SPAM')).toBe(true);
    expect(hasLabel(['INBOX'], 'spam')).toBe(false);
    expect(hasLabel(null, 'spam')).toBe(false);
  });

  it('removes every casing of a label and keeps the rest', () => {
    expect(withoutLabel(['SPAM', 'STARRED', 'spam'], 'spam')).toEqual(['STARRED']);
    expect(withoutLabel(undefined, 'spam')).toEqual([]);
  });

  it('adds a label once', () => {
    expect(withLabel(['STARRED'], 'INBOX')).toEqual(['STARRED', 'INBOX']);
    expect(withLabel(['inbox'], 'INBOX')).toEqual(['inbox']);
  });

  it('keeps only the labels a person put on the mail', () => {
    expect(userLabelsOf(['SENT', 'STARRED', 'PINNED', 'E2E Label Renamed', 'IMPORTANT', 'ARCHIVE', 'muted'])).toEqual([
      'E2E Label Renamed',
    ]);
    expect(userLabelsOf(null)).toEqual([]);
  });
});
