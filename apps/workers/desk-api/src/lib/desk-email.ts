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
import type { DeskMessageAttachment } from '@weldsuite/db/schema/desk-messages';
import type { Database } from '@weldsuite/worker-kit/db';
import { sendEmail } from '@weldsuite/worker-email';
import { guardedSend, OutboundDeniedError } from '@weldsuite/mail-domain/outbound';
import type { Env } from '../types';
import { withoutTrailingSlash } from './url';
import { warnReplyBlocked, type DeskOutboundContext } from './outbound-guard';

function replySubject(subject: string | null | undefined): string {
  const trimmed = (subject ?? '').trim() || 'Support';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** Files up to this many bytes in total ride along as real MIME attachments; the rest become links. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface MimeAttachment {
  filename: string;
  content: ArrayBuffer;
  contentType: string;
}

/** Agent files live under `desk/<workspace>/<conversation>/` in STORAGE, served at R2_PUBLIC_URL. */
function storageKeyFor(env: Env, url: string): string | null {
  const base = env.R2_PUBLIC_URL ? withoutTrailingSlash(env.R2_PUBLIC_URL) : undefined;
  if (!base || !url.startsWith(`${base}/desk/`)) return null;
  const key = url.slice(base.length + 1);
  return key.includes('..') ? null : key;
}

/**
 * Split an agent's files into MIME attachments (read from STORAGE, up to the
 * total cap) and links for everything else: too big for the cap, not readable
 * from our bucket, or the object is gone.
 */
export async function prepareEmailAttachments(
  env: Env,
  files: DeskMessageAttachment[] | null | undefined,
): Promise<{ attached: MimeAttachment[]; linked: DeskMessageAttachment[] }> {
  const attached: MimeAttachment[] = [];
  const linked: DeskMessageAttachment[] = [];
  let total = 0;
  for (const file of files ?? []) {
    const key = storageKeyFor(env, file.url);
    if (!key || !env.STORAGE || total + (file.filesize || 0) > MAX_EMAIL_ATTACHMENT_BYTES) {
      linked.push(file);
      continue;
    }
    try {
      const object = await env.STORAGE.get(key);
      if (!object || total + object.size > MAX_EMAIL_ATTACHMENT_BYTES) {
        linked.push(file);
        continue;
      }
      total += object.size;
      attached.push({
        filename: file.name,
        content: await object.arrayBuffer(),
        contentType: file.contentType || 'application/octet-stream',
      });
    } catch (err) {
      console.warn(`[desk-email] Could not read attachment ${key}, sending a link instead:`, err);
      linked.push(file);
    }
  }
  return { attached, linked };
}

/** The plain-text body: the reply, then a list of any files sent as links. */
export function emailTextBody(
  body: string | null | undefined,
  attached: Array<{ filename: string }>,
  linked: DeskMessageAttachment[],
): string {
  const parts: string[] = [];
  const text = body?.trim();
  if (text) parts.push(text);
  if (linked.length > 0) {
    const lines = linked.map((f) => `- ${f.name}: ${f.url}`);
    parts.push(`Attachments:\n${lines.join('\n')}`);
  } else if (!text && attached.length > 0) {
    parts.push(`Attachments: ${attached.map((f) => f.filename).join(', ')}`);
  }
  return parts.join('\n\n');
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
  const hasFiles = (message.attachments?.length ?? 0) > 0;
  if (!recipient || (!message.body?.trim() && !hasFiles)) return;

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
  const { attached, linked } = await prepareEmailAttachments(env, message.attachments);
  const body = emailTextBody(message.body, attached, linked);

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
        attachments: attached.map((a) => ({ filename: a.filename, contentType: a.contentType })),
      },
      () =>
        sendEmail(env, {
          from,
          to: [recipient],
          subject,
          text: body,
          attachments: attached.length > 0 ? attached : undefined,
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
