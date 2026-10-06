import { describe, expect, it, vi } from 'vitest';
import { collectWorkspaceMemberPages } from './workspace-member-pages';

describe('collectWorkspaceMemberPages', () => {
  it('returns a single page when nothing follows it', async () => {
    const fetchPage = vi.fn(async () => ({
      data: [{ userId: 'user_a' }],
      pagination: { hasMore: false, cursor: null },
    }));

    await expect(collectWorkspaceMemberPages(fetchPage)).resolves.toEqual([{ userId: 'user_a' }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(null);
  });

  it('follows the cursor until the directory is exhausted', async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) {
        return { data: [{ userId: 'user_a' }], pagination: { hasMore: true, cursor: 'cursor_1' } };
      }
      if (cursor === 'cursor_1') {
        return { data: [{ userId: 'user_b' }], pagination: { hasMore: true, cursor: 'cursor_2' } };
      }
      return { data: [{ userId: 'user_c' }], pagination: { hasMore: false, cursor: null } };
    });

    await expect(collectWorkspaceMemberPages(fetchPage)).resolves.toEqual([
      { userId: 'user_a' },
      { userId: 'user_b' },
      { userId: 'user_c' },
    ]);
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([null, 'cursor_1', 'cursor_2']);
  });

  it('stops when the next cursor repeats or the page cap is hit', async () => {
    const repeating = vi.fn(async () => ({
      data: [{ userId: 'user_a' }],
      pagination: { hasMore: true, cursor: 'same' },
    }));
    const members = await collectWorkspaceMemberPages(repeating);
    expect(members).toEqual([{ userId: 'user_a' }, { userId: 'user_a' }]);
    expect(repeating).toHaveBeenCalledTimes(2);

    const unbounded = vi.fn(async (cursor: string | null) => ({
      data: [{ userId: cursor ?? 'start' }],
      pagination: { hasMore: true, cursor: cursor === null ? 'p1' : `p-after-${cursor}` },
    }));
    const capped = await collectWorkspaceMemberPages(unbounded, 3);
    expect(capped).toHaveLength(3);
    expect(unbounded).toHaveBeenCalledTimes(3);
  });
});
