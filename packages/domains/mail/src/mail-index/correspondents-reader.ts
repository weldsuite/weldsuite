/**
 * The production `CorrespondentsReader`: pages tenant Postgres
 * `mail_correspondents` directly, the same way `MailboxObject`'s backfill is
 * designed to read `mail_messages` from its own alarm (design doc §4,
 * "each alarm opens the tenant DB through `getTenantDbForWorkspace`").
 *
 * `MailIndex` cannot be unit-tested against a real Postgres instance (the
 * `durable-sqlite` fakes run in vitest's `node` environment, with no network
 * Postgres reachable), so this reader is injected through
 * `MailIndexEnv.correspondentsReader` rather than hard-wired: production
 * leaves the field unset and gets this function; tests set it to a stub that
 * returns canned pages. This keeps the object itself free of any Postgres
 * mocking in its own test file, and needs no new worker route.
 */

import { asc, gt } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import type { CorrespondentRow, CorrespondentsPage, CorrespondentsReader } from './types';

const { mailCorrespondents } = schema;
type MailCorrespondentRecord = typeof mailCorrespondents.$inferSelect;

function toEpochMs(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function toRow(record: MailCorrespondentRecord): CorrespondentRow {
  return {
    email: record.email,
    firstInboundAt: toEpochMs(record.firstInboundAt),
    lastInboundAt: toEpochMs(record.lastInboundAt),
    inboundCount: record.inboundCount,
    firstOutboundAt: toEpochMs(record.firstOutboundAt),
    lastOutboundAt: toEpochMs(record.lastOutboundAt),
    outboundCount: record.outboundCount,
    repliedAfterFirstContact: record.repliedAfterFirstContact,
  };
}

/** Builds a reader bound to this worker's `DbEnv` (master DB + Neon + KV cache for tenant resolution). */
export function defaultCorrespondentsReader(env: DbEnv): CorrespondentsReader {
  return async (workspaceId: string, cursor: string | null, limit: number): Promise<CorrespondentsPage> => {
    const db = await getTenantDbForWorkspace(env, workspaceId);
    const rows = await db
      .select()
      .from(mailCorrespondents)
      .where(cursor ? gt(mailCorrespondents.email, cursor) : undefined)
      .orderBy(asc(mailCorrespondents.email))
      .limit(limit);
    const last = rows.at(-1);
    return {
      rows: rows.map(toRow),
      nextCursor: rows.length < limit || !last ? null : last.email,
    };
  };
}
