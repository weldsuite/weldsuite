import type { BoardElement } from '@weldsuite/board-engine';
import { CHAT_TOKEN, userMention } from '@/components/record-comments/mentions';

/**
 * What the comments panel shows: the Filter button's choices (status and
 * people) and the search. Open threads from everyone is the default.
 */
export type CommentStatus = 'open' | 'resolved' | 'all';
export type CommentPeople = 'everyone' | 'mentions' | 'mine';

export interface CommentFilters {
  status: CommentStatus;
  people: CommentPeople;
  query: string;
}

export const DEFAULT_COMMENT_FILTERS: CommentFilters = { status: 'open', people: 'everyone', query: '' };

/** How many of the Filter button's choices differ from the default (the count it shows). */
export function activeFilterCount(f: CommentFilters): number {
  return (f.status === 'open' ? 0 : 1) + (f.people === 'everyone' ? 0 : 1);
}

/** What a thread says, as far as filtering goes. */
export interface CommentThreadText {
  /** What the pin is on (its element's text). */
  label: string;
  messages: readonly { authorId: string; authorName: string; content: string; mentions: string[] | null }[];
}

/** A message's text as people read it: mentions as the names they show. */
function readable(content: string): string {
  return content.replace(CHAT_TOKEN, (_token, inner: string) => userMention(inner)?.name ?? '');
}

function mentions(message: CommentThreadText['messages'][number], me: string): boolean {
  return !!message.mentions?.includes(me) || message.content.includes(`<@${me}:`) || message.content.includes(`<@${me}>`);
}

/** Whether a comment pin's thread passes the filters (`me` is the person looking). */
export function commentMatches(pin: BoardElement, thread: CommentThreadText, f: CommentFilters, me: string): boolean {
  if (f.status === 'open' && pin.resolved) return false;
  if (f.status === 'resolved' && !pin.resolved) return false;
  if (f.people === 'mine' && pin.createdBy !== me) return false;
  if (f.people === 'mentions' && !thread.messages.some((m) => mentions(m, me))) return false;
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [thread.label, ...thread.messages.flatMap((m) => [m.authorName, readable(m.content)])].join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}
