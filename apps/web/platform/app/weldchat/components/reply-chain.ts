/**
 * Discord-style reply chains.
 *
 * An inline reply carries `metadata.replyTo` (built by chat-api) with its
 * position in the chain (`depth`) and the message that started it (`rootId`).
 * Replying deep into a chain makes the composer suggest continuing the
 * conversation in a thread on the root message.
 */

import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import type { ReplyTo } from './chat-context';

/**
 * Replying to a message already this deep in a chain (the new message would
 * be the 4th in it) shows the "continue in a thread?" suggestion.
 */
export const THREAD_SUGGESTION_DEPTH = 2;

interface ReplyReference {
  rootId?: string;
  depth?: number;
}

/** The composer reply target for a message, including its chain position. */
export function replyToFromMessage(message: ChatMessage): ReplyTo {
  const ref = (message.metadata as { replyTo?: ReplyReference } | null | undefined)?.replyTo;
  return {
    messageId: message.id,
    authorName: message.authorName ?? '',
    content: message.content ?? '',
    parentId: message.parentId,
    depth: ref?.depth ?? 0,
    rootId: ref?.rootId ?? message.id,
  };
}

// Text typed in the channel composer, handed to the thread composer that
// opens when a reply chain moves into a thread (keyed by the thread's root).
const pendingThreadDrafts = new Map<string, string>();

export function stashThreadDraft(threadRootId: string, content: string): void {
  if (content.trim()) pendingThreadDrafts.set(threadRootId, content);
}

export function takeThreadDraft(threadRootId: string): string | null {
  const draft = pendingThreadDrafts.get(threadRootId) ?? null;
  pendingThreadDrafts.delete(threadRootId);
  return draft;
}
