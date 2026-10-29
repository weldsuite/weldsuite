/**
 * Build one thread's summary from its live messages.
 *
 * Moved out of `../threads` (design task A3) so both the Postgres store and
 * the mailbox object's `refreshThread` (design §3.2) share the exact
 * aggregation rules: participants, label union, latest sender, attachment
 * flag, unread count. `../threads` imports these back; behaviour unchanged.
 * Pure: no I/O.
 */

import type { ThreadListMessage, ThreadSummary } from '../threads';

/**
 * The title of a thread: its first message's subject without reply prefixes.
 * A forward keeps its `Fwd:`, which tells the conversation from the mail it
 * was forwarded from.
 */
export function normalizeSubject(subject: string | null): string {
  if (!subject) return '(No subject)';
  return subject.replace(/^(?:re:\s*)+/i, '') || '(No subject)';
}

function dateOf(...candidates: (Date | null | undefined)[]): number {
  for (const c of candidates) {
    if (c instanceof Date) return c.getTime();
    if (typeof c === 'string') return new Date(c).getTime();
  }
  return 0;
}

export function summarizeThreadMessages(threadMessages: ThreadListMessage[]): {
  participants: string[];
  labels: string[];
  hasAttachments: boolean;
  isStarred: boolean;
  unreadCount: number;
} {
  const participants = new Set<string>();
  const labels = new Set<string>();
  let hasAttachments = false;
  let isStarred = false;
  let unreadCount = 0;
  for (const msg of threadMessages) {
    const from = msg.from as { name?: string; email?: string } | null;
    const sender = from?.name || from?.email;
    if (sender) participants.add(sender);
    if (Array.isArray(msg.labels)) {
      for (const l of msg.labels as string[]) labels.add(l);
    }
    if (msg.hasAttachments) hasAttachments = true;
    if (msg.isStarred) isStarred = true;
    if (!msg.isRead) unreadCount += 1;
  }
  if (labels.has('STARRED')) isStarred = true;
  return { participants: [...participants], labels: [...labels], hasAttachments, isStarred, unreadCount };
}

export function buildThreadSummary(
  row: { accountId: string; threadId: string },
  threadMessages: ThreadListMessage[],
): ThreadSummary {
  threadMessages.sort(
    (a, b) =>
      dateOf(a.receivedDate, a.sentDate, a.createdAt) -
      dateOf(b.receivedDate, b.sentDate, b.createdAt),
  );

  const first = threadMessages[0]!;
  const latest = threadMessages.at(-1)!;
  const { participants, labels, hasAttachments, isStarred, unreadCount } =
    summarizeThreadMessages(threadMessages);

  const latestFrom = latest.from as { name?: string; email?: string } | null;
  const latestSender = latestFrom?.name || latestFrom?.email || 'Unknown';
  const latestSenderEmail = latestFrom?.email ?? '';

  return {
    threadId: row.threadId,
    accountId: row.accountId,
    subject: normalizeSubject(first.subject),
    participants,
    latestMessageId: latest.id,
    latestSender,
    latestSenderEmail,
    latestSenderAvatarUrl: null,
    latestDate: latest.receivedDate ?? latest.sentDate ?? latest.createdAt ?? null,
    preview: latest.preview ?? '',
    messageCount: threadMessages.length,
    unreadCount,
    hasAttachments,
    isStarred,
    labels,
    scheduledFor: latest.scheduledFor ?? null,
    sendStatus: latest.sendStatus ?? null,
    messages: threadMessages,
  };
}
