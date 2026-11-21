import { mailApi, type CreateDraftData } from './api-client';
import type { Mail } from '@/lib/api/types/apps/mail.types';

/** What a scheduled message brings back to Drafts. */
export type ScheduledMessage = Pick<Mail.Email, 'subject' | 'to' | 'cc' | 'bcc' | 'textBody' | 'htmlBody' | 'attachments'> & {
  inReplyTo?: string | null;
};

/** A stored address list (`{ email, name }` rows or plain strings) as the plain addresses a draft keeps. */
function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: unknown) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'email' in entry) return String(entry.email ?? '');
      return '';
    })
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}

/**
 * The draft a cancelled scheduled mail turns back into. Its attachments are
 * left out: a draft has nowhere to keep them yet (TASK-1448), see
 * {@link droppedAttachmentCount}.
 */
export function draftFromScheduled(message: ScheduledMessage): CreateDraftData {
  const draft: CreateDraftData = { to: addressList(message.to) };
  const cc = addressList(message.cc);
  const bcc = addressList(message.bcc);
  if (cc.length > 0) draft.cc = cc;
  if (bcc.length > 0) draft.bcc = bcc;
  if (message.subject) draft.subject = message.subject;
  if (message.textBody) draft.body = message.textBody;
  if (message.htmlBody) draft.htmlBody = message.htmlBody;
  if (message.inReplyTo) draft.inReplyTo = message.inReplyTo;
  return draft;
}

/** How many attachments the draft will not have: every one the scheduled mail carries. */
export function droppedAttachmentCount(message: ScheduledMessage): number {
  return message.attachments?.length ?? 0;
}

export type LoadScheduledResult = { success: true; message: ScheduledMessage } | { success: false; error?: string };

/** The scheduled mail as it is now, read before asking, so the question can name what is lost. */
export async function loadScheduledMessage(accountId: string, messageId: string): Promise<LoadScheduledResult> {
  const message = await mailApi.messages.get(accountId, messageId);
  if (!message.success || !message.data) return { success: false, error: message.error };
  return { success: true, message: message.data };
}

export type CancelScheduledResult = { success: true; draftId: string } | { success: false; error?: string };

/**
 * Cancel a scheduled mail and put it back in Drafts, where it can be edited
 * or scheduled again. Cancelling deletes the scheduled row, so the draft is
 * written first; when the cancel then fails (the mail went out in the
 * meantime, say) the draft is removed again, and the mail is never in two
 * places. The draft keeps the recipients, subject and body but not the
 * attachments, which drafts cannot hold yet: the caller must have said so and
 * had it confirmed ({@link droppedAttachmentCount}).
 */
export async function cancelScheduledToDraft(
  accountId: string,
  messageId: string,
  scheduled: ScheduledMessage,
): Promise<CancelScheduledResult> {
  const draft = await mailApi.drafts.create(accountId, draftFromScheduled(scheduled));
  if (!draft.success || !draft.data) return { success: false, error: draft.error };

  const cancelled = await mailApi.scheduled.cancel(messageId);
  if (!cancelled.success) {
    await mailApi.drafts.delete(accountId, draft.data.id);
    return { success: false, error: cancelled.error };
  }
  return { success: true, draftId: draft.data.id };
}
