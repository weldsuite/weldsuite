/**
 * Outbound email for WeldDesk conversations with channel=email.
 * Inbound is handled by mail-inbound-worker via ingestDeskEmail.
 */

import {
  getDeskEmailReplyContext,
  stampDeskMessageEmailId,
  type DeskConversation,
  type DeskMessage,
} from '@weldsuite/db/lib/desk';
import type { Database } from '../db';
import { sendEmail } from './cloudflare-email';
import type { Env } from '../types';

function replySubject(subject: string | null | undefined): string {
  const trimmed = (subject ?? '').trim() || 'Support';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export async function sendDeskEmailReply(
  env: Env,
  db: Database,
  conversation: DeskConversation,
  message: DeskMessage,
): Promise<void> {
  if (conversation.channel !== 'email' || message.kind !== 'message') return;
  if (!conversation.email || !message.body?.trim()) return;

  const thread = await getDeskEmailReplyContext(db, conversation.id);
  const from = thread?.helpdeskAddress;
  if (!from) {
    console.warn(
      `[desk-email] Skipping outbound send for ${conversation.id}: no helpdesk address on the thread`,
    );
    return;
  }

  const inReplyTo = thread.lastEmailMessageId ?? undefined;
  const references = thread.references ?? [];

  const result = await sendEmail(env, {
    from,
    to: [conversation.email],
    subject: replySubject(thread.subject ?? conversation.title),
    text: message.body,
    inReplyTo,
    references: references.length > 0 ? references : undefined,
  });

  if (result.messageId) {
    await stampDeskMessageEmailId(db, message.id, result.messageId);
  }
}
