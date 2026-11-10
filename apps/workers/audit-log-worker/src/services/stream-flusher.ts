/**
 * Pushes a workspace's new audit rows to its audit log streams (SIEM), once
 * its batch of rows is written. The delivery rules (cursor, batches, backoff,
 * auto-disable) are `@weldsuite/core-domain/audit-streams`; this is only the
 * worker's side of it.
 */

import { flushAuditLogStreams, type AuditStreamsDb } from '@weldsuite/core-domain/audit-streams';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { Database } from '../db';
import type { Env } from '../env';

/** Cheap when the workspace has no streams (one small query); never throws. */
export async function flushStreamsForWorkspace(db: Database, workspaceId: string, env: Env): Promise<void> {
  await flushAuditLogStreams(db as unknown as AuditStreamsDb, { keyring: keyringFromEnv(env), workspaceId });
}
