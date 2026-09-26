/**
 * Pure formatting helpers shared by the email-detail surfaces
 * (`app/[id].tsx` and `components/EmailDetailPanel.tsx`).
 *
 * Extracted verbatim from both files — behaviour is byte-identical to the
 * previous local copies, so this is a safe de-duplication. (Note: each screen
 * keeps its own `getInitialColor` because their avatar palettes intentionally
 * differ, and `formatPlatformDate` lives only in `[id].tsx`.)
 */

export function getSenderName(from: any): string {
  if (!from) return '(No sender)';
  if (typeof from === 'string') return from;
  return from.name || from.email || '(No sender)';
}

export function getSenderEmail(from: any): string {
  if (!from) return '';
  if (typeof from === 'string') return from;
  return from.email || '';
}

export function formatRecipients(recipients: any): string {
  if (!recipients) return '';
  if (typeof recipients === 'string') return recipients;
  if (Array.isArray(recipients)) {
    return recipients
      .map((r) => (typeof r === 'string' ? r : r.name || r.email || ''))
      .filter(Boolean)
      .join(', ');
  }
  return recipients.name || recipients.email || '';
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function formatMessageDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) {
    return `${date.getHours().toString().padStart(2, '0')}:${date
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
  }
  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}`;
}

export type ComposeMode = 'reply' | 'replyAll' | 'forward';

export interface ComposeReplyParams {
  mode: ComposeMode;
  replyTo: string;
  replyCc: string;
  subject: string;
  quotedFrom: string;
  quotedDate: string;
  quotedSubject: string;
  quotedBody: string;
  emailAccountId: string;
  /** SMTP Message-ID of the original, so the reply threads (empty on forward). */
  inReplyTo: string;
  /** Space-separated References chain for the reply (empty on forward). */
  references: string;
}

const ADDRESS_PATTERN = /[^\s<>,;"']+@[^\s<>,;"']+/g;

/**
 * Bare email addresses from a recipient value: a `{ name, email }` list, a
 * list of strings, or a raw header string such as `"Doe, Jane" <jane@x.com>`.
 * Display names are never returned: the composer treats every entry as an
 * address, and a name like "Doe, Jane" would split into two bogus recipients.
 */
export function recipientAddresses(recipients: any): string[] {
  if (!recipients) return [];
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const out: string[] = [];
  for (const r of list) {
    const raw = typeof r === 'string' ? r : r?.email;
    if (typeof raw !== 'string') continue;
    out.push(...(raw.match(ADDRESS_PATTERN) ?? []));
  }
  return out;
}

function uniqueAddresses(addresses: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const a of addresses) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function prefixedSubject(subject: unknown, prefix: 'Re' | 'Fwd'): string {
  const base = typeof subject === 'string' ? subject : '';
  const already = prefix === 'Re' ? /^re:/i : /^(fwd?|fw):/i;
  return already.test(base.trim()) ? base : `${prefix}: ${base}`;
}

/**
 * Build the reply/reply-all/forward prefill for the composer from a message.
 * Shared by `app/[id].tsx` and `components/EmailDetailPanel.tsx`;
 * `fallbackAccountId` is the per-screen `email?.emailAccountId || email?.accountId`
 * fallback. `selfAddresses` are the user's own mailbox addresses, left out of
 * reply-all so the user doesn't mail themselves.
 */
export function buildComposeParams(
  msg: any,
  mode: ComposeMode,
  fallbackAccountId = '',
  selfAddresses: string[] = [],
): ComposeReplyParams {
  const sName = getSenderName(msg.from) || 'Unknown';
  const sEmail = getSenderEmail(msg.from);
  const self = new Set(selfAddresses.map((a) => a.toLowerCase()));
  const senderAddresses = recipientAddresses(msg.from);
  const toAddresses = recipientAddresses(msg.to);
  const ccAddresses = recipientAddresses(msg.cc);
  // Replying to a message you sent yourself goes to its original recipients.
  const fromSelf = senderAddresses.some((a) => self.has(a.toLowerCase()));

  let replyTo: string[] = [];
  let replyCc: string[] = [];
  let subject = '';

  if (mode === 'reply') {
    replyTo = fromSelf ? uniqueAddresses(toAddresses, self) : senderAddresses.slice(0, 1);
    subject = prefixedSubject(msg.subject, 'Re');
  } else if (mode === 'replyAll') {
    replyTo = uniqueAddresses(fromSelf ? toAddresses : [...senderAddresses, ...toAddresses], self);
    replyCc = uniqueAddresses(ccAddresses, new Set([...self, ...replyTo.map((a) => a.toLowerCase())]));
    subject = prefixedSubject(msg.subject, 'Re');
  } else {
    subject = prefixedSubject(msg.subject, 'Fwd');
  }

  const isReply = mode !== 'forward';
  const smtpId = typeof msg.messageId === 'string' ? msg.messageId : '';
  const priorRefs: string[] = Array.isArray(msg.references) ? msg.references.filter((r: unknown) => typeof r === 'string') : [];
  const references = isReply && smtpId ? [...priorRefs.filter((r) => r !== smtpId), smtpId].join(' ') : '';

  return {
    mode,
    replyTo: replyTo.join(', '),
    replyCc: replyCc.join(', '),
    subject,
    quotedFrom: `${sName} (${sEmail})`,
    quotedDate: msg.sentDate || msg.receivedDate || msg.receivedAt || msg.createdAt || '',
    quotedSubject: msg.subject || '',
    quotedBody: msg.textBody || msg.textContent || msg.body || msg.preview || '',
    emailAccountId: msg.emailAccountId || msg.accountId || fallbackAccountId,
    inReplyTo: isReply ? smtpId : '',
    references,
  };
}
