/**
 * Realtime + entity-event fan-out for WeldDesk phone transcripts.
 * Public Telnyx webhooks have no Clerk context, so we use the raw publisher.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';
import type { Env } from '../types';
import type { Database } from '../db';

export async function fanoutDeskPhoneMessage(args: {
  env: Env;
  db: Database;
  workspaceId: string;
  conversation: DeskConversation;
  message: DeskMessage;
  action: 'created' | 'updated';
}): Promise<void> {
  const { env, db, workspaceId, conversation, message, action } = args;

  if (action === 'created') {
    await publishEntityEventRaw({
      env,
      db,
      workspaceId,
      userId: 'system',
      entityType: 'desk_message',
      action: 'created',
      entityId: message.id,
      data: { ...message, conversationId: conversation.id } as unknown as Record<string, unknown>,
      source: 'system',
    });
  }

  await publishEntityEventRaw({
    env,
    db,
    workspaceId,
    userId: 'system',
    entityType: 'desk_conversation',
    action: 'updated',
    entityId: conversation.id,
    data: conversation as unknown as Record<string, unknown>,
    source: 'system',
  });

  if (!env.REALTIME) return;
  try {
    const rt = new RealtimePublisher(env.REALTIME);
    await rt.conversationPublish(conversation.id, {
      type: 'message',
      id: message.id,
      content: message.body ?? '',
      senderId: message.authorId ?? 'system',
      senderType: message.authorType,
      kind: message.kind,
      ts: Date.now(),
    });
  } catch (err) {
    console.error('[desk-phone] realtime publish failed:', err);
  }
}
