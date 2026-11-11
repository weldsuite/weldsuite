/**
 * The worker's side of the audit log stream flush: a workspace with an active
 * stream is flushed after the settle window has passed, a workspace without
 * one is not made to wait.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasActive = vi.fn<(db: unknown) => Promise<boolean>>();
const flush = vi.fn<(db: unknown, options: Record<string, unknown>) => Promise<unknown[]>>();

vi.mock('@weldsuite/core-domain/audit-streams', () => ({
  AUDIT_STREAM_SETTLE_MS: 5_000,
  hasActiveAuditLogStreams: (db: unknown) => hasActive(db),
  flushAuditLogStreams: (db: unknown, options: Record<string, unknown>) => flush(db, options),
}));

import type { Database } from '../db';
import type { Env } from '../env';
import { STREAM_FLUSH_DELAY_MS, flushStreamsForWorkspace } from './stream-flusher';

const db = { handle: 'tenant-db' } as unknown as Database;
const env = { DATABASE_ENCRYPTION_KEY: 'k1', DATABASE_ENCRYPTION_KEY_V2: 'k2' } as unknown as Env;

beforeEach(() => {
  hasActive.mockReset();
  flush.mockReset().mockResolvedValue([]);
});

describe('flushStreamsForWorkspace', () => {
  it('waits a little longer than the settle window', () => {
    expect(STREAM_FLUSH_DELAY_MS).toBe(6_000);
  });

  it('does not wait, and does not flush, for a workspace without an active stream', async () => {
    hasActive.mockResolvedValue(false);
    const wait = vi.fn(async () => {});

    await flushStreamsForWorkspace(db, 'ws_1', env, wait);

    expect(hasActive).toHaveBeenCalledWith(db);
    expect(wait).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('checks for a stream, waits out the delay, then flushes with the keyring and the workspace', async () => {
    const order: string[] = [];
    hasActive.mockImplementation(async () => {
      order.push('check');
      return true;
    });
    const wait = vi.fn(async (ms: number) => {
      order.push(`wait ${ms}`);
    });
    flush.mockImplementation(async () => {
      order.push('flush');
      return [];
    });

    await flushStreamsForWorkspace(db, 'ws_1', env, wait);

    expect(order).toEqual(['check', `wait ${STREAM_FLUSH_DELAY_MS}`, 'flush']);
    expect(flush).toHaveBeenCalledTimes(1);
    const [flushedDb, options] = flush.mock.calls[0]!;
    expect(flushedDb).toBe(db);
    expect(options).toMatchObject({ workspaceId: 'ws_1', keyring: { v1: 'k1', v2: 'k2' } });
    // The flush takes its own "now" after the wait, never one from before it.
    expect(options).not.toHaveProperty('now');
  });

  it('really pauses for the delay when no wait is injected', async () => {
    vi.useFakeTimers();
    try {
      hasActive.mockResolvedValue(true);
      const done = flushStreamsForWorkspace(db, 'ws_1', env);
      await vi.advanceTimersByTimeAsync(STREAM_FLUSH_DELAY_MS - 1);
      expect(flush).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
