/** Pure helpers for the reply inbox: read state, message order and who can be answered. */

import type {
  ReachMessage,
  ReachThreadSummary,
} from '@weldsuite/app-api-client/schemas/reach';

export type InboxState = 'unread' | 'open' | 'handled' | 'all';

export const INBOX_STATES: InboxState[] = ['open', 'unread', 'handled', 'all'];

/** A thread is unread while its latest reply has not been opened. */
export function isUnread(summary: Pick<ReachThreadSummary, 'lastInbound'>): boolean {
  return summary.lastInbound.readAt === null;
}

export function isHandled(summary: Pick<ReachThreadSummary, 'lastInbound'>): boolean {
  return summary.lastInbound.handledAt !== null;
}

/** When a message happened: received for replies, sent for our emails. */
export function messageTime(message: Pick<ReachMessage, 'receivedAt' | 'sentAt'>): number {
  const value = message.receivedAt ?? message.sentAt;
  return value ? new Date(value).getTime() : 0;
}

/** Oldest first, so the conversation reads top to bottom. */
export function sortMessages(messages: ReachMessage[]): ReachMessage[] {
  return [...messages].sort((a, b) => messageTime(a) - messageTime(b));
}

/** Replies of the thread nobody has opened yet. */
export function unreadInboundIds(messages: ReachMessage[]): string[] {
  return messages
    .filter((message) => message.direction === 'in' && message.readAt === null)
    .map((message) => message.id);
}

/** A bounce means the address does not exist; there is nobody to answer. */
export function canReplyToThread(messages: ReachMessage[]): boolean {
  const last = sortMessages(messages)
    .reverse()
    .find((message) => message.direction === 'in');
  return last !== undefined && last.kind !== 'bounce';
}

/** The text of a message: the stored body, or its snippet while the body is not available. */
export function messageText(message: Pick<ReachMessage, 'bodyText' | 'snippet'>): string {
  return message.bodyText?.trim() || message.snippet?.trim() || '';
}
