/**
 * Mirror a message posted in a company / person chat channel (the composer in
 * the CRM record panel) into the record's Activity feed.
 *
 * The record panel's Activity tab reads `crm_activities`, while the composer
 * writes `chat_messages` in the entity's channel, so without this the message
 * never showed up in the feed. Every message becomes one completed `comment`
 * activity linked to the company (`customerId`) or person (`personId`).
 *
 * Best-effort: callers swallow errors so a failure here can never block a chat
 * message. Edits / deletes of the message are not mirrored.
 */

import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const SUBJECT_MAX = 255;

export interface EntityChannelRef {
  entityType: string | null;
  entityId: string | null;
  entityDisplayName: string | null;
}

/** Plain-text one-liner for the activity subject. */
function toSubject(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUBJECT_MAX) return flat;
  return `${flat.slice(0, SUBJECT_MAX - 1)}…`;
}

/** True when the channel belongs to a CRM record whose Activity tab should list its messages. */
export function isCrmEntityChannel(channel: EntityChannelRef): channel is {
  entityType: 'company' | 'person';
  entityId: string;
  entityDisplayName: string | null;
} {
  return (channel.entityType === 'company' || channel.entityType === 'person') && !!channel.entityId;
}

export async function logEntityChannelMessageActivity(
  db: Database,
  params: {
    channel: EntityChannelRef;
    authorUserId: string;
    content: string;
    createdAt?: Date;
  },
): Promise<void> {
  const { channel, authorUserId, content } = params;
  if (!isCrmEntityChannel(channel)) return;
  const subject = toSubject(content);
  if (!subject) return;

  const isCompany = channel.entityType === 'company';
  const now = params.createdAt ?? new Date();
  await db.insert(schema.crmActivities).values({
    id: generateId('act'),
    type: 'comment',
    subject,
    description: content,
    relatedTo: isCompany ? 'customer' : 'contact',
    relatedToId: channel.entityId,
    relatedToName: channel.entityDisplayName ?? undefined,
    customerId: isCompany ? channel.entityId : undefined,
    personId: isCompany ? undefined : channel.entityId,
    assignedToId: authorUserId,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });
}
