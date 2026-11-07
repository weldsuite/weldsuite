/**
 * Where a customer's message on a merged duplicate goes: the conversation it
 * was merged into, following the chain when that one was merged on in turn.
 * appendDeskMessage (./desk) calls this for every visitor message, so each
 * channel (widget, email, portal, phone, the API) lands on the kept
 * conversation. The Rust twin is `weldsuite_desk_domain::links::merge_target`.
 */

import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { DeskConversation } from '../schema/desk-conversations';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A merge chain longer than this is a data error; the last one reached is used. */
const MAX_MERGE_HOPS = 10;

/** The conversation `conversation` was (finally) merged into, or itself. */
export async function deskMergeTarget(db: AnyDb, conversation: DeskConversation): Promise<DeskConversation> {
  let current = conversation;
  const seen = new Set([current.id]);
  for (let hop = 0; current.mergedIntoId && hop < MAX_MERGE_HOPS; hop++) {
    if (seen.has(current.mergedIntoId)) break;
    const [next] = await db
      .select()
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, current.mergedIntoId))
      .limit(1);
    if (!next) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}
