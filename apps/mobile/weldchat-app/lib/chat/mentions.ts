/**
 * Chat mention helpers shared by the channel and thread screens.
 *
 * Message bodies carry mentions as tokens:
 *   <@userId>             → user mention (label resolved from the roster)
 *   <@userId:DisplayName> → user mention with an inline label
 *   <@type:id|Label>      → entity reference
 *   <@file:attachmentId>  → one of the message's own attachments, placed at
 *                           this spot in the text (an image pasted on the web).
 *                           The file itself still travels in `attachments`.
 */

const MENTION_TOKEN_TEST = /<@[^>]+>/;

/** Prefix of an inline attachment token: `<@file:attachmentId>`. */
export const FILE_TOKEN_PREFIX = 'file';

/** The attachment id an inline file token names, or null for any other token body. */
export function fileTokenId(token: string): string | null {
  const prefix = `${FILE_TOKEN_PREFIX}:`;
  if (!token.startsWith(prefix)) return null;
  return token.slice(prefix.length) || null;
}

/** Attachment ids placed inline in `text`, in order, without duplicates. */
export function fileTokenIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(mentionTokenRegex())) {
    const id = fileTokenId(match[1]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `text` without its inline file tokens (the file shows from `attachments` instead). */
export function stripFileTokens(text: string): string {
  return text.replace(mentionTokenRegex(), (raw, token: string) => (fileTokenId(token) === null ? raw : ''));
}

export type MessageBodyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'file'; attachmentId: string };

/**
 * Split a message body at its inline file tokens. Tokens whose attachment
 * isn't in `attachmentIds` are dropped; the line breaks around an inline file
 * are dropped too, since the file already sits on its own line.
 */
export function splitInlineFiles(text: string, attachmentIds: ReadonlySet<string>): MessageBodyBlock[] {
  const blocks: MessageBodyBlock[] = [];
  let pending = '';
  let lastIndex = 0;
  const pushText = (afterFile: boolean, beforeFile: boolean) => {
    let chunk = pending;
    if (afterFile) chunk = chunk.replace(/^[^\S\n]*\n/, '');
    if (beforeFile) chunk = chunk.replace(/\n[^\S\n]*$/, '');
    if (chunk.trim()) blocks.push({ kind: 'text', text: chunk });
    pending = '';
  };
  for (const match of text.matchAll(mentionTokenRegex())) {
    const id = fileTokenId(match[1]);
    if (id === null) continue;
    pending += text.substring(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    if (!attachmentIds.has(id)) continue;
    pushText(blocks.at(-1)?.kind === 'file', true);
    blocks.push({ kind: 'file', attachmentId: id });
  }
  pending += text.substring(lastIndex);
  pushText(blocks.at(-1)?.kind === 'file', false);
  return blocks;
}

/** A fresh global regex for iterating `<@…>` tokens (global regexes are stateful). */
export function mentionTokenRegex(): RegExp {
  return /<@([^>]+)>/g;
}

/** Whether an id names a WeldAgent workspace agent rather than a person. */
export function isAgentId(id: string): boolean {
  return id.startsWith('agt_');
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

/** Replace mention tokens with plain `@Name` text and drop inline file tokens (one-line previews). */
export function mentionsToPlainText(text: string, members: Map<string, string>): string {
  return text.replace(mentionTokenRegex(), (_, token: string) =>
    fileTokenId(token) === null ? `@${mentionLabel(token, members)}` : '',
  );
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
