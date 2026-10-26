/**
 * Mentions in comments. The comment box writes a mention as `@[Name](userId)`
 * while you type; WeldChat stores it as a `<@userId:Name>` token, which is
 * what the comment's message holds and what notifies the person.
 */

const DRAFT_MENTION = /@\[([^\]]*)\]\(([^)\s]+)\)/g;
/** A WeldChat token: `<@userId>`, `<@userId:Name>` or `<@type:id|Label>`. */
export const CHAT_TOKEN = /<@([^>]+)>/g;

/** A comment box's text as a chat message: its content and the people it mentions. */
export function toChatContent(body: string): { content: string; mentions: string[] } {
  const mentions = new Set<string>();
  const content = body.trim().replace(DRAFT_MENTION, (_, name: string, id: string) => {
    mentions.add(id);
    return `<@${id}:${name.replace(/[<>]/g, '')}>`;
  });
  return { content, mentions: [...mentions] };
}

/** A message's text back in the comment box, to edit. */
export function fromChatContent(content: string): string {
  return content.replace(CHAT_TOKEN, (token, inner: string) => {
    const mention = userMention(inner);
    return mention ? `@[${mention.name}](${mention.id})` : token;
  });
}

/** The person a token names (`userId` or `userId:Name`), or null for anything else. */
export function userMention(inner: string, names?: ReadonlyMap<string, string>): { id: string; name: string } | null {
  if (inner.includes('|') || inner.startsWith('file:')) return null;
  const colon = inner.indexOf(':');
  const id = colon === -1 ? inner : inner.slice(0, colon);
  const name = colon === -1 ? (names?.get(id) ?? id) : inner.slice(colon + 1);
  return { id, name };
}

/** What a token shows: a person's name, or a linked record's label. */
export function tokenLabel(inner: string, names?: ReadonlyMap<string, string>): string {
  const pipe = inner.indexOf('|');
  if (pipe !== -1) return inner.slice(pipe + 1);
  return userMention(inner, names)?.name ?? inner;
}

/** A message's text as plain text: mentions as `@Name`. */
export function plainComment(content: string, names?: ReadonlyMap<string, string>): string {
  return content.replace(CHAT_TOKEN, (_, inner: string) => `@${tokenLabel(inner, names)}`);
}
