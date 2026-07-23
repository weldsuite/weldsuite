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
  if (isNaN(date.getTime())) return '';
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
}

/**
 * Build the reply/reply-all/forward prefill for the composer from a message.
 * Extracted verbatim from the identical `openComposeForMessage` in both
 * `app/[id].tsx` and `components/EmailDetailPanel.tsx`; `fallbackAccountId` is
 * the per-screen `email?.emailAccountId || email?.accountId` fallback.
 */
export function buildComposeParams(
  msg: any,
  mode: ComposeMode,
  fallbackAccountId = '',
): ComposeReplyParams {
  const sName = getSenderName(msg.from) || 'Unknown';
  const sEmail = getSenderEmail(msg.from);
  const ccVal = typeof msg.cc === 'string' ? msg.cc : formatRecipients(msg.cc);

  let replyTo = '';
  let replyCc = '';
  let subjectPrefix = '';

  if (mode === 'reply') {
    replyTo = sEmail;
    subjectPrefix = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`;
  } else if (mode === 'replyAll') {
    replyTo = sEmail;
    replyCc = ccVal;
    subjectPrefix = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`;
  } else {
    subjectPrefix = msg.subject?.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject}`;
  }

  return {
    mode,
    replyTo,
    replyCc,
    subject: subjectPrefix,
    quotedFrom: `${sName} (${sEmail})`,
    quotedDate: msg.sentDate || msg.receivedDate || msg.receivedAt || msg.createdAt || '',
    quotedSubject: msg.subject || '',
    quotedBody: msg.textBody || msg.textContent || msg.body || msg.preview || '',
    emailAccountId: msg.emailAccountId || msg.accountId || fallbackAccountId,
  };
}
