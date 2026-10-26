/**
 * One-line message previews for the sidebar, push notifications and realtime
 * pings.
 *
 * Message bodies carry mentions as `<@…>` tokens, so a preview cut straight
 * from the body reads "hey <@user_2x…>" in a notification. These helpers turn
 * every token into the text a reader expects:
 *
 *   <@userId>              → @Name (workspace member, or agent for `agt_…`)
 *   <@userId:DisplayName>  → @DisplayName
 *   <@type:id|Label>       → @Label (entity reference)
 *   <@everyone>            → @everyone
 *   <@file:attachmentId>   → removed (an inline image shows nothing in one line)
 */

import { inArray } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';

const MENTION_TOKEN = /<@([^>]+)>/g;
const FILE_TOKEN = /<@file:[^>]*>/g;
const PREVIEW_MAX_LENGTH = 100;
/** Shown for a mention whose member or agent no longer exists. */
const UNKNOWN_MENTION_LABEL = 'unknown';

/** Ids of the bare `<@id>` tokens in `content`, the ones that need a name lookup. */
export function bareMentionIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION_TOKEN)) {
    const body = match[1];
    if (body.includes(':') || body.includes('|') || body === 'everyone') continue;
    ids.add(body);
  }
  return [...ids];
}

/** The label a `<@…>` token body reads as, without the leading `@`. */
function mentionLabel(body: string, names: ReadonlyMap<string, string>): string {
  const pipeIdx = body.indexOf('|');
  if (pipeIdx !== -1) return body.slice(pipeIdx + 1) || UNKNOWN_MENTION_LABEL;
  const colonIdx = body.indexOf(':');
  if (colonIdx !== -1) return body.slice(colonIdx + 1) || UNKNOWN_MENTION_LABEL;
  if (body === 'everyone') return 'everyone';
  return names.get(body) ?? UNKNOWN_MENTION_LABEL;
}

/**
 * `content` as a one-line preview: mention tokens rendered as `@Name`, inline
 * file tokens dropped, runs of spaces collapsed, cut at 100 characters.
 */
export function formatMessagePreview(content: string, names: ReadonlyMap<string, string>): string {
  const text = content
    .replace(FILE_TOKEN, '')
    .replace(MENTION_TOKEN, (_, body: string) => `@${mentionLabel(body, names)}`)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}...` : text;
}

/** Display names of the members and agents mentioned by bare `<@id>` tokens in `content`. */
export async function resolveMentionNames(db: Database, content: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = bareMentionIds(content);
  if (ids.length === 0) return names;

  const agentIds = ids.filter((id) => id.startsWith('agt_'));
  const userIds = ids.filter((id) => !id.startsWith('agt_'));
  const { workspaceMembers, weldagentAgents } = schema;

  const [members, agents] = await Promise.all([
    userIds.length > 0
      ? db
          .select({ id: workspaceMembers.userId, name: workspaceMembers.name })
          .from(workspaceMembers)
          .where(inArray(workspaceMembers.userId, userIds))
      : Promise.resolve([]),
    agentIds.length > 0
      ? db
          .select({ id: weldagentAgents.id, name: weldagentAgents.name })
          .from(weldagentAgents)
          .where(inArray(weldagentAgents.id, agentIds))
      : Promise.resolve([]),
  ]);
  for (const row of [...members, ...agents]) {
    if (row.name) names.set(row.id, row.name);
  }
  return names;
}

/**
 * Preview of `content` with its mentions resolved against the workspace. A
 * failed name lookup still yields a preview (unresolved mentions read
 * `@unknown`), so a send never fails over it.
 */
export async function buildMessagePreview(db: Database, content: string): Promise<string> {
  let names = new Map<string, string>();
  try {
    names = await resolveMentionNames(db, content);
  } catch (err) {
    console.error('[chat-domain] mention name lookup for preview failed:', err);
  }
  return formatMessagePreview(content, names);
}
