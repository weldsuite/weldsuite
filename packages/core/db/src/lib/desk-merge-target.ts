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

/**
 * Where a customer message written on `conversation` lands: the conversation
 * it was (finally) merged into when the customer who writes on the duplicate
 * can see that one, else the duplicate itself (which then reopens, showing
 * that it was merged).
 *
 * "Can see" is the widget and help-center ownership rule
 * (`canAccessDeskConversation`, ./desk-portal): the same visitor, or a
 * verified email that matches. A merge can also join two conversations of the
 * same CRM person written from different, unverified identities; following it
 * there would put the customer's message where they can never read the reply.
 */
export async function deskMergeFollowUpTarget(
  db: AnyDb,
  conversation: DeskConversation,
): Promise<DeskConversation> {
  const target = await deskMergeTarget(db, conversation);
  if (target.id === conversation.id) return conversation;
  if (conversation.visitorId && target.visitorId === conversation.visitorId) return target;
  const writer = await verifiedEmails(db, conversation);
  if (writer.size === 0) return conversation;
  const kept = await verifiedEmails(db, target);
  for (const email of writer) if (kept.has(email)) return target;
  return conversation;
}

/**
 * The verified addresses a conversation's customer writes from: the sender of
 * an email conversation, and its visitor's verified email.
 */
async function verifiedEmails(db: AnyDb, conversation: DeskConversation): Promise<Set<string>> {
  const emails = new Set<string>();
  if (conversation.channel === 'email' && conversation.email) {
    emails.add(conversation.email.trim().toLowerCase());
  }
  if (conversation.visitorId) {
    const [visitor] = await db
      .select({ verifiedEmail: schema.deskVisitors.verifiedEmail })
      .from(schema.deskVisitors)
      .where(eq(schema.deskVisitors.id, conversation.visitorId))
      .limit(1);
    if (visitor?.verifiedEmail) emails.add(visitor.verifiedEmail.trim().toLowerCase());
  }
  return emails;
}

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
