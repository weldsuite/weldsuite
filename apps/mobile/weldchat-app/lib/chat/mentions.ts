/**
 * Chat mention helpers shared by the channel and thread screens.
 *
 * Message bodies carry mentions as tokens:
 *   <@userId>             → user mention (label resolved from the roster)
 *   <@userId:DisplayName> → user mention with an inline label
 *   <@type:id|Label>      → entity reference
 */

const MENTION_TOKEN_TEST = /<@[^>]+>/;

/** A fresh global regex for iterating `<@…>` tokens (global regexes are stateful). */
export function mentionTokenRegex(): RegExp {
  return /<@([^>]+)>/g;
}

export function hasMentionTokens(text: string): boolean {
  return MENTION_TOKEN_TEST.test(text);
}

/** Display label for the inside of a `<@…>` token. */
export function mentionLabel(token: string, members: Map<string, string>): string {
  const pipeIdx = token.indexOf('|');
  if (pipeIdx !== -1) return token.slice(pipeIdx + 1);
  const colonIdx = token.indexOf(':');
  if (colonIdx !== -1) return token.slice(colonIdx + 1);
  return members.get(token) ?? 'unknown';
}

/** Replace mention tokens with plain `@Name` text (one-line previews). */
export function mentionsToPlainText(text: string, members: Map<string, string>): string {
  return text.replace(mentionTokenRegex(), (_, token: string) => `@${mentionLabel(token, members)}`);
}

/**
 * The `@query` being typed at the end of the composer text, or null when the
 * caret isn't in a mention. `@` must start the text or follow whitespace (a
 * space or a newline), so e-mail addresses don't open the picker.
 */
export function detectMentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@<>]*)$/.exec(text);
  return match ? match[1] : null;
}

/** Swap the trailing `@query` for a mention token of the picked member. */
export function insertMention(text: string, userId: string): string {
  return text.replace(/@[^\s@<>]*$/, `<@${userId}> `);
}
