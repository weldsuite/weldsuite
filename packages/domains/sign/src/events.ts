/**
 * The evidence trail (`sign_events`). Append-only: nothing in sign-api updates
 * or deletes a row, except deleting a draft, which never reached anyone.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SignEventType } from '@weldsuite/db/schema';

export interface SignEventInput {
  envelopeId: string;
  recipientId?: string | null;
  type: SignEventType;
  actorUserId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

export async function recordSignEvent(db: Database, input: SignEventInput): Promise<void> {
  await db.insert(schema.signEvents).values({
    id: generateId('sge'),
    envelopeId: input.envelopeId,
    recipientId: input.recipientId ?? null,
    type: input.type,
    actorUserId: input.actorUserId ?? null,
    actorName: input.actorName ?? null,
    actorEmail: input.actorEmail ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    details: input.details ?? null,
  });
}
