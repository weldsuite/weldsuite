import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  buildGridViewPayload,
  useGridViewPersistence,
  GRID_VIEW_SAVE_DEBOUNCE_MS,
  type GridViewPayload,
} from './use-grid-view-persistence';
import type { GridColumnDef } from './types';

const col = (id: string, visible = true, width = 150) =>
  ({ id, name: id, visible, width }) as unknown as GridColumnDef<unknown>;

const SAVED: GridViewPayload = {
  columnVisibility: { name: true, ownerId: true, 'custom:region': true, website: false },
  columnWidths: { name: 300, ownerId: 180, 'custom:region': 200, website: 150 },
};

describe('buildGridViewPayload', () => {
  const config = [col('name', true, 150), col('ownerId', false, 150), col('website', true, 150)];

  it('returns null when the live state equals the saved view', () => {
    const columns = [col('name', true), col('ownerId', true), col('website', false)];
    expect(
      buildGridViewPayload({
        columns,
        columnWidths: { name: 300, ownerId: 180, website: 150 },
        configColumns: config,
        saved: SAVED,
      }),
    ).toBeNull();
  });

  it('treats columns missing from the saved view as unchanged when at their config default', () => {
    expect(
      buildGridViewPayload({
        columns: [col('name', true), col('custom:new', false, 160)],
        columnWidths: { name: 300, 'custom:new': 160 },
        configColumns: [col('name'), col('custom:new', false, 160)],
        saved: SAVED,
      }),
    ).toBeNull();
  });

  it('keeps saved keys for columns that are not rendered yet (custom:* before defs load)', () => {
    const payload = buildGridViewPayload({
      columns: [col('name', false), col('ownerId', true), col('website', false)],
      columnWidths: { name: 300, ownerId: 180, website: 150 },
      configColumns: config,
      saved: SAVED,
    });
    expect(payload?.columnVisibility).toEqual({
      name: false,
      ownerId: true,
      'custom:region': true,
      website: false,
    });
    expect(payload?.columnWidths['custom:region']).toBe(200);
  });

  it('detects a width change', () => {
    const payload = buildGridViewPayload({
      columns: [col('name', true), col('ownerId', true), col('website', false)],
      columnWidths: { name: 420, ownerId: 180, website: 150 },
      configColumns: config,
      saved: SAVED,
    });
    expect(payload?.columnWidths.name).toBe(420);
  });
});

describe('useGridViewPersistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const run = (initial: Parameters<typeof useGridViewPersistence<unknown>>[0]) =>
    renderHook((props) => useGridViewPersistence(props), { initialProps: initial });

  const base = () => ({
    columns: [col('name', true), col('ownerId', true), col('website', false)],
    columnWidths: { name: 300, ownerId: 180, website: 150 },
    configColumns: [col('name'), col('ownerId', false), col('website')],
    initialVisibility: SAVED.columnVisibility,
    initialColumnWidths: SAVED.columnWidths,
  });

  it('never PUTs on mount or when config re-syncs without a user change', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = run({ ...base(), save });
    await act(async () => {
      vi.advanceTimersByTime(GRID_VIEW_SAVE_DEBOUNCE_MS * 2);
    });
    // New array identities (e.g. unrelated company PATCH re-memoising config,
    // custom field defs arriving) are not user changes.
    rerender({ ...base(), save });
    rerender({ ...base(), configColumns: [...base().configColumns, col('custom:new', false, 160)], save });
    await act(async () => {
      vi.advanceTimersByTime(GRID_VIEW_SAVE_DEBOUNCE_MS * 2);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('PUTs once, merged with the saved view, when the user hides a column', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = run({ ...base(), save });
    rerender({ ...base(), columns: [col('name', true), col('ownerId', false), col('website', false)], save });
    await act(async () => {
      vi.advanceTimersByTime(GRID_VIEW_SAVE_DEBOUNCE_MS + 10);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].columnVisibility).toMatchObject({ ownerId: false, 'custom:region': true });

    // The same state again is now the baseline: no second PUT.
    rerender({ ...base(), columns: [col('name', true), col('ownerId', false), col('website', false)], save });
    await act(async () => {
      vi.advanceTimersByTime(GRID_VIEW_SAVE_DEBOUNCE_MS * 2);
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
