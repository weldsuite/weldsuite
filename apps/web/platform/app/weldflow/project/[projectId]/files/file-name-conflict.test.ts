import { describe, expect, it } from 'vitest';
import { findFileNameConflict } from './file-name-conflict';

describe('findFileNameConflict', () => {
  const files = [
    { id: 'f1', fileName: 'Report.pdf', isFolder: false },
    { id: 'd1', fileName: 'Report.pdf', isFolder: true },
    { id: 'f2', fileName: 'notes.txt', isFolder: false },
  ];

  it('returns the matching non-folder file (case-insensitive)', () => {
    expect(findFileNameConflict('report.pdf', files)).toEqual({
      id: 'f1',
      fileName: 'Report.pdf',
      isFolder: false,
    });
  });

  it('ignores folders with the same name', () => {
    expect(findFileNameConflict('Report.pdf', [
      { id: 'd1', fileName: 'Report.pdf', isFolder: true },
    ])).toBeNull();
  });

  it('returns null when no match', () => {
    expect(findFileNameConflict('other.pdf', files)).toBeNull();
  });

  it('returns null for blank names', () => {
    expect(findFileNameConflict('   ', files)).toBeNull();
  });
});
