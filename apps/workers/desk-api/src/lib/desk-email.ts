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
import type { Database } from '@weldsuite/worker-kit/db';
import { sendEmail } from '@weldsuite/worker-email';
import { guardedSend, OutboundDeniedError } from '@weldsuite/mail-domain/outbound';
import type { Env } from '../types';
import { warnReplyBlocked, type DeskOutboundContext } from './outbound-guard';

function replySubject(subject: string | null | undefined): string {
  const trimmed = (subject ?? '').trim() || 'Support';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export async function sendDeskEmailReply(
  env: Env,
  db: Database,
  conversation: DeskConversation,
  message: DeskMessage,
  outbound: DeskOutboundContext,
): Promise<void> {
  if (conversation.channel !== 'email' || message.kind !== 'message') return;
  const recipient = conversation.email;
  const body = message.body;
  if (!recipient || !body?.trim()) return;

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
  const subject = replySubject(thread.subject ?? conversation.title);

  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    // An agent answering a customer who wrote in: the guard counts it as a reply.
    result = await guardedSend(
      env,
      db,
      {
        subject: { kind: 'workspace', clerkOrgId: outbound.clerkOrgId },
        source: 'desk',
        kind: 'reply',
        from,
        to: [recipient],
        subjectLine: subject,
        text: body,
      },
      () =>
        sendEmail(env, {
          from,
          to: [recipient],
          subject,
          text: body,
          inReplyTo,
          references: references.length > 0 ? references : undefined,
        }),
      { waitUntil: outbound.waitUntil },
    );
  } catch (err) {
    // A refusal is logged, like any other failed send here: the reply is already stored.
    if (err instanceof OutboundDeniedError) {
      warnReplyBlocked('desk-email', conversation.id, err);
      return;
    }
    throw err;
  }

  if (result.messageId) {
    await stampDeskMessageEmailId(db, message.id, result.messageId);
  }
}
