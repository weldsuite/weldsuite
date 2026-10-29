/**
 * What a mail list row shows beyond the sender: the recipients on mail the user
 * sent, and the wake time of snoozed mail. Pure functions so the rules are
 * tested without rendering a list.
 */

import type { ThreadListMessageRow, ThreadSummary } from './thread-utils';
import { hasLabel } from './message-labels';

/** The label a message carries for each folder that lists the user's own mail. */
const OUTGOING_FOLDER_LABELS: Record<string, readonly string[]> = {
  sent: ['SENT'],
  scheduled: ['SCHEDULED'],
  drafts: ['DRAFT', 'DRAFTS'],
};

/** Sent, Drafts and Scheduled list mail the user wrote: the row names who it goes to, not the sender. */
export function isOutgoingFolder(folder: string): boolean {
  return folder.toLowerCase() in OUTGOING_FOLDER_LABELS;
}

export interface RowRecipient {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface RecipientSummary {
  /** "Jane Doe, bob@example.com": names where there are any, addresses otherwise. */
  names: string;
  avatarUrl?: string;
}

function messageTime(message: ThreadListMessageRow): number {
  const stamp = message.sentDate ?? message.receivedDate ?? message.scheduledFor ?? message.createdAt;
  return stamp ? new Date(stamp).getTime() : 0;
}

/** The message of the thread that belongs to `folder`, newest first; any message when none is labelled for it. */
function outgoingMessage(messages: readonly ThreadListMessageRow[], folder: string): ThreadListMessageRow | undefined {
  const newestFirst = [...messages].sort((a, b) => messageTime(b) - messageTime(a));
  const labels = OUTGOING_FOLDER_LABELS[folder.toLowerCase()] ?? [];
  const belongs = newestFirst.find((m) => labels.some((label) => hasLabel(m.labels, label)));
  return belongs ?? newestFirst[0];
}

/** Who the thread's outgoing mail goes to. */
export function outgoingRecipients(thread: ThreadSummary, folder: string): RowRecipient[] {
  const messages = thread.messages ?? [];
  // Draft rows are built from the draft itself: `participants` holds its addresses.
  if (messages.length === 0) return thread.participants.filter(Boolean).map((email) => ({ email }));
  return outgoingMessage(messages, folder)?.to ?? [];
}

/** One line for a list of recipients, plus the first one's avatar. Null when there is nobody. */
export function summarizeRecipients(recipients: readonly RowRecipient[]): RecipientSummary | null {
  const named = recipients.filter((r) => r.email || r.name);
  if (named.length === 0) return null;
  return {
    names: named.map((r) => r.name?.trim() || r.email).join(', '),
    avatarUrl: named[0].avatarUrl ?? undefined,
  };
}

/** The soonest wake time among the thread's snoozed messages, or null when none is snoozed. */
export function earliestSnoozedUntil(messages: readonly ThreadListMessageRow[] | undefined): Date | null {
  let soonest: Date | null = null;
  for (const message of messages ?? []) {
    if (!message.snoozedUntil) continue;
    const when = new Date(message.snoozedUntil);
    if (Number.isNaN(when.getTime())) continue;
    if (!soonest || when < soonest) soonest = when;
  }
  return soonest;
}

/** Ids of the thread's messages that are snoozed right now (what "Unsnooze" wakes). */
export function snoozedMessageIds(messages: readonly ThreadListMessageRow[] | undefined): string[] {
  return (messages ?? [])
    .filter((m) => Boolean(m.snoozedUntil) || hasLabel(m.labels, 'SNOOZED'))
    .map((m) => m.id);
}
