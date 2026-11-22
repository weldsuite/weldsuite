import { tagsAsText } from './record-tags';

/** Longest chat name shown in a header or the Recent chats list. */
const MAX_CHAT_TITLE = 60;

/**
 * A chat's name, made from its first message: record tags as their names, on
 * one line, cut to 60 characters. Empty when the message has no text, so the
 * caller can fall back to "Untitled chat" or "New chat".
 */
export function chatTitleFrom(firstMessage: string): string {
  return tagsAsText(firstMessage).replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_TITLE);
}
