/**
 * Discord-style inline replies: the snapshot of the quoted message a reply
 * carries at `chat_messages.metadata.replyTo`.
 *
 * Shared by the human send path (chat-api `postChatMessage`) and agent replies
 * (`@weldsuite/agent-domain` room dispatch), so both quote a message the same
 * way and clients render one shape.
 */

/**
 * Snapshot of the message an inline reply answers, stored at
 * `chat_messages.metadata.replyTo`. `depth` is the reply's position in the
 * chain (a reply to a plain message is 1, a reply to that reply 2, …) and
 * `rootId` is the message that started the chain, so clients can suggest
 * moving a long back-and-forth into a thread on the root.
 */
export interface ChatReplyReference {
  messageId: string;
  rootId: string;
  depth: number;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  hasAttachments: boolean;
}

const REPLY_SNIPPET_LENGTH = 200;

/** Truncate a quoted message without leaving half a `<@…>` token behind. */
export function replySnippet(content: string): string {
  if (content.length <= REPLY_SNIPPET_LENGTH) return content;
  return content.slice(0, REPLY_SNIPPET_LENGTH).replace(/<@[^>]*$/, '').trimEnd() + '…';
}

/** The reply snapshot a message's metadata carries, if any. */
export function readReplyReference(metadata: unknown): ChatReplyReference | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const ref = (metadata as Record<string, unknown>).replyTo;
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as Partial<ChatReplyReference>;
  return typeof r.messageId === 'string' ? (r as ChatReplyReference) : null;
}

/** The message being answered, as loaded from `chat_messages`. */
export interface ReplyTarget {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  hasAttachments: boolean | null;
  metadata: unknown;
}

/** Build the snapshot for a reply to `target`, continuing its reply chain. */
export function buildReplyReference(target: ReplyTarget): ChatReplyReference {
  const previous = readReplyReference(target.metadata);
  return {
    messageId: target.id,
    rootId: previous?.rootId ?? target.id,
    depth: (previous?.depth ?? 0) + 1,
    authorId: target.authorId,
    authorName: target.authorName,
    authorAvatar: target.authorAvatar ?? null,
    content: replySnippet(target.content),
    hasAttachments: target.hasAttachments === true,
  };
}
