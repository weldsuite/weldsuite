/**
 * Who a WeldMail reply goes to, and which stored message it answers.
 *
 * The server derives the actual recipients from the message being answered
 * (`replyRecipients` in `@weldsuite/mail-domain/send`, `reply_recipients` in
 * the Rust port); the helpers here show the same set in the reply's To field,
 * so keep the rules in step.
 */

import type { Mail as MailTypes } from '@/lib/api/types/apps/mail.types';

type EmailMessage = MailTypes.Email;

/** Prefix of the id a sent reply carries until the thread refetches. */
export const OPTIMISTIC_ID_PREFIX = 'optimistic-';

// `to`/`cc`/`bcc` entries may be plain email strings or structured
// Mail.EmailAddress objects; normalize a single entry down to its email.
export function addressToEmail(addr: string | MailTypes.EmailAddress | undefined): string {
  if (!addr) return '';
  return typeof addr === 'string' ? addr : addr.email;
}

export function addressListToEmails(list?: string[] | MailTypes.EmailAddress[]): string[] {
  return (list || []).map((item) => addressToEmail(item));
}

/**
 * Recipients for a reply, To before Cc.
 *
 * Answering someone else's mail: a plain reply goes to the original sender
 * only; a reply-all adds everyone else who was on the To/Cc lines. Following up
 * on mail we sent ourselves: it goes to the people that mail went to (plus its
 * Cc with reply-all), like Gmail and Outlook; addressing the sender there would
 * only mail ourselves. Our own address is left off, except on a note we only
 * ever sent to ourselves.
 */
export function buildReplyRecipients(
  msg: EmailMessage,
  { all, selfEmail }: { all: boolean; selfEmail?: string },
): string[] {
  const self = selfEmail?.trim().toLowerCase();
  const fromEmail = (msg.fromEmail || addressToEmail(msg.from)).trim();
  const seen = new Set<string>();
  const recipients: string[] = [];
  const add = (email: string) => {
    const trimmed = email.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key) || key === self) return;
    seen.add(key);
    recipients.push(trimmed);
  };
  if (self && fromEmail.toLowerCase() === self) {
    addressListToEmails(msg.to).forEach(add);
    if (all) addressListToEmails(msg.cc).forEach(add);
    return recipients.length > 0 ? recipients : [fromEmail];
  }
  add(fromEmail);
  if (all) {
    addressListToEmails(msg.to).forEach(add);
    addressListToEmails(msg.cc).forEach(add);
  }
  return recipients;
}

/** "Reply all" only earns its place when it reaches somebody a plain reply would leave out. */
export function hasExtraReplyAllRecipients(msg: EmailMessage, selfEmail?: string): boolean {
  return (
    buildReplyRecipients(msg, { all: true, selfEmail }).length >
    buildReplyRecipients(msg, { all: false, selfEmail }).length
  );
}

/**
 * The stored message a reply answers: the one picked (`replyToMessageId`),
 * else the newest. A reply sent a moment ago only exists as an optimistic
 * placeholder until the thread refetches; it has no server id to reply to, so
 * the newest stored message stands in for it.
 */
export function resolveReplyTarget(
  messages: EmailMessage[],
  replyToMessageId: string | null,
  newest: EmailMessage,
): EmailMessage {
  const picked = messages.find((m) => m.id === replyToMessageId) ?? newest;
  if (!picked.id.startsWith(OPTIMISTIC_ID_PREFIX)) return picked;
  const stored = messages.filter((m) => !m.id.startsWith(OPTIMISTIC_ID_PREFIX));
  stored.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  return stored[0] ?? picked;
}
