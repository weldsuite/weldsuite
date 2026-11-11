/**
 * Timeline messages the phone flows write on a call's desk conversation:
 * system lines ("Call answered by Anna", "Missed call"), the voicemail. Each is
 * fanned out like the other phone messages. Best-effort: a failure is logged
 * and never fails the webhook or the route.
 */

import { appendDeskMessage } from '@weldsuite/db/lib/desk';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { fanoutDeskPhoneMessage } from './desk-phone-fanout';

export async function postPhoneMessage(
  env: Env,
  db: Database,
  workspaceId: string,
  conversationId: string | null | undefined,
  input: { body: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (!conversationId) return;
  try {
    const result = await appendDeskMessage(db, {
      generateId,
      conversationId,
      kind: 'message',
      authorType: 'system',
      body: input.body,
      metadata: input.metadata,
    });
    await fanoutDeskPhoneMessage({
      env,
      db,
      workspaceId,
      conversation: result.conversation,
      message: result.message,
      action: 'created',
    });
  } catch (err) {
    console.error('[desk-phone] failed to post phone message:', err);
  }
}

/** A member's display name for timeline lines: name, else email, else null. */
export async function memberDisplayName(db: Database, userId: string): Promise<string | null> {
  const m = schema.workspaceMembers;
  const [row] = await db.select({ name: m.name, email: m.email }).from(m).where(eq(m.userId, userId)).limit(1);
  return row?.name?.trim() || row?.email?.trim() || null;
}
