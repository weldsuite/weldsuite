import { describe, it, expect } from 'vitest';
import { reconcileSavedVisibility, reconcileSavedWidths, sameRecord } from './saved-view';

const col = (id: string, visible = true) => ({ id, visible });
const config = [col('name'), col('website'), col('ownerId', false)];

describe('reconcileSavedVisibility', () => {
  it('applies the saved view to columns still on their defaults', () => {
    const columns = [col('name'), col('website'), col('ownerId', false)];
    const next = reconcileSavedVisibility(columns, {
      previous: null,
      next: { ownerId: true, website: false },
      configColumns: config,
    });
    expect(next.map((c) => [c.id, c.visible])).toEqual([
      ['name', true],
      ['website', false],
      ['ownerId', true],
    ]);
  });

  it('leaves a column the user changed since the previous view', () => {
    // Previous view said Owner is visible, the user hid it.
    const columns = [col('name'), col('website'), col('ownerId', false)];
    const next = reconcileSavedVisibility(columns, {
      previous: { ownerId: true },
      next: { ownerId: true, website: false },
      configColumns: config,
    });
    expect(next.find((c) => c.id === 'ownerId')?.visible).toBe(false);
    expect(next.find((c) => c.id === 'website')?.visible).toBe(false);
  });

  it('returns the same array when nothing changes', () => {
    const columns = [col('name'), col('website'), col('ownerId', false)];
    expect(
      reconcileSavedVisibility(columns, { previous: null, next: { name: true }, configColumns: config }),
    ).toBe(columns);
    expect(reconcileSavedVisibility(columns, { previous: null, next: null, configColumns: config })).toBe(columns);
  });

  it('ignores saved keys for columns the grid does not have', () => {
    const columns = [col('name')];
    expect(
      reconcileSavedVisibility(columns, { previous: null, next: { 'custom:tier': true }, configColumns: config }),
    ).toBe(columns);
  });
});

describe('reconcileSavedWidths', () => {
  const configWidths = { name: 280, website: 200 };

  it('applies saved widths to columns still at their default width', () => {
    expect(
      reconcileSavedWidths({ name: 280, website: 200 }, { previous: null, next: { name: 400 }, configWidths }),
    ).toEqual({ name: 400, website: 200 });
  });

  it('keeps a width the user dragged', () => {
    expect(
      reconcileSavedWidths(
        { name: 320, website: 200 },
        { previous: { name: 300 }, next: { name: 400 }, configWidths },
      ),
    ).toEqual({ name: 320, website: 200 });
  });

  it('does not add widths for columns the grid does not have yet', () => {
    const widths = { name: 280 };
    expect(reconcileSavedWidths(widths, { previous: null, next: { 'custom:tier': 150 }, configWidths })).toBe(widths);
  });
});

describe('sameRecord', () => {
  it('compares by content, treating null and empty alike', () => {
    expect(sameRecord({ a: true }, { a: true })).toBe(true);
    expect(sameRecord({ a: true }, { a: false })).toBe(false);
    expect(sameRecord({ a: true }, { a: true, b: true })).toBe(false);
    expect(sameRecord(null, {})).toBe(true);
    expect(sameRecord(undefined, null)).toBe(true);
  });
});
