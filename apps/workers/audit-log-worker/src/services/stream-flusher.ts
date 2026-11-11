/**
 * Pushes a workspace's new audit rows to its audit log streams (SIEM), once
 * its batch of rows is written. The delivery rules (cursor, settle window,
 * batches, backoff, auto-disable) are `@weldsuite/core-domain/audit-streams`;
 * this is only the worker's side of it.
 *
 * A flush only reads rows older than the settle window
 * (`AUDIT_STREAM_SETTLE_MS`), so one that ran straight after the writes would
 * leave them behind until the workspace's next audit event. The flush
 * therefore runs `STREAM_FLUSH_DELAY_MS` later, a little longer than the
 * window. A workspace without an active stream does not wait: one small query
 * says so first.
 */

import {
  AUDIT_STREAM_SETTLE_MS,
  flushAuditLogStreams,
  hasActiveAuditLogStreams,
  type AuditStreamsDb,
} from '@weldsuite/core-domain/audit-streams';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { Database } from '../db';
import type { Env } from '../env';

/** How long after a batch's writes its streams are flushed: the settle window and a second. */
export const STREAM_FLUSH_DELAY_MS = AUDIT_STREAM_SETTLE_MS + 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Flush the workspace's streams once the rows just written have settled.
 * Returns at once when the workspace has no active stream; never throws.
 * `wait` is the pause, injected in tests.
 */
export async function flushStreamsForWorkspace(
  db: Database,
  workspaceId: string,
  env: Env,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const streamsDb = db as unknown as AuditStreamsDb;
  if (!(await hasActiveAuditLogStreams(streamsDb))) return;
  await wait(STREAM_FLUSH_DELAY_MS);
  await flushAuditLogStreams(streamsDb, { keyring: keyringFromEnv(env), workspaceId });
}
