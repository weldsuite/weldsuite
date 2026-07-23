/**
 * Shared `<@…>` token renderer for WeldChat surfaces.
 *
 * One regex, three callers — message body, forwarded-message body, and the
 * composer's reply preview. Eliminates three near-duplicate copies.
 *
 * Token grammar:
 *   <@userId>                   — user mention (existing)
 *   <@userId:DisplayName>       — user mention with name override (existing,
 *                                 used for channel-agent badges and forwards
 *                                 across workspaces)
 *   <@type:id|Label>            — entity reference (NEW). The type prefix
 *                                 must match `VALID_TYPES`; otherwise the
 *                                 token falls back to the user-name-override
 *                                 path.
 *
 * The renderer is plain text → ReactNode. It does NOT process inline markdown
 * formatting (`**bold**`, `*italic*`, etc.) — callers that need that should
 * pre-split or post-process; today only `message-item.tsx` needs that.
 */

import type { ReactNode } from 'react';
import { VALID_TYPES } from '@/components/entity-sheet/url-param';
import type { EntitySheetType } from '@/components/entity-sheet/types';

const MENTION_TOKEN_REGEX = /<@([^>]+)>/g;

export type ChatTokenSegment =
  | { kind: 'text'; text: string }
  | { kind: 'user'; userId: string; displayName: string | null }
  | { kind: 'entity'; entityType: EntitySheetType; entityId: string; label: string | null };

/**
 * Parse a chat-message body into a flat list of segments. The caller is
 * responsible for rendering each segment; this is just classification.
 */
export function parseChatTokens(text: string): ChatTokenSegment[] {
  const segments: ChatTokenSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state — required because MENTION_TOKEN_REGEX is module-scoped.
  MENTION_TOKEN_REGEX.lastIndex = 0;

  while ((match = MENTION_TOKEN_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.substring(lastIndex, match.index) });
    }

    const body = match[1];
    const colonIdx = body.indexOf(':');

    if (colonIdx === -1) {
      // <@userId>
      segments.push({ kind: 'user', userId: body, displayName: null });
    } else {
      const prefix = body.slice(0, colonIdx);
      const rest = body.slice(colonIdx + 1);

      if (VALID_TYPES.has(prefix)) {
        // <@type:id|Label> entity reference
        const pipeIdx = rest.indexOf('|');
        const id = pipeIdx === -1 ? rest : rest.slice(0, pipeIdx);
        const label = pipeIdx === -1 ? null : rest.slice(pipeIdx + 1);
        if (id) {
          segments.push({
            kind: 'entity',
            entityType: prefix as EntitySheetType,
            entityId: id,
            label: label && label.length > 0 ? label : null,
          });
        } else {
          // Malformed — preserve as plain text so we don't lose data.
          segments.push({ kind: 'text', text: match[0] });
        }
      } else {
        // <@userId:DisplayName> — user mention with name override
        segments.push({ kind: 'user', userId: prefix, displayName: rest || null });
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.substring(lastIndex) });
  }

  return segments;
}

interface RenderChatTokensOptions {
  /** Renders one user mention. Receives the resolved displayName fallback (null when caller has no map entry). */
  renderUser: (segment: { userId: string; displayName: string | null }, key: string) => ReactNode;
  /** Renders one entity mention. */
  renderEntity: (
    segment: { entityType: EntitySheetType; entityId: string; label: string | null },
    key: string,
  ) => ReactNode;
  /** Optional: transform plain-text segments. Default: identity. */
  renderText?: (text: string, key: string) => ReactNode;
}

/**
 * Walk segments and emit ReactNodes via the caller-supplied renderers.
 * Designed to keep all three call sites in lockstep on token grammar.
 */
export function renderChatTokens(text: string, opts: RenderChatTokensOptions): ReactNode[] {
  const segments = parseChatTokens(text);
  return segments.map((seg, i) => {
    const key = `s${i}`;
    if (seg.kind === 'text') {
      return opts.renderText ? opts.renderText(seg.text, key) : seg.text;
    }
    if (seg.kind === 'user') {
      return opts.renderUser({ userId: seg.userId, displayName: seg.displayName }, key);
    }
    return opts.renderEntity(
      { entityType: seg.entityType, entityId: seg.entityId, label: seg.label },
      key,
    );
  });
}

/**
 * Build the inline token string for an entity reference.
 * Used by the composer when inserting a chip; the label is escaped so it
 * cannot contain `|` or `>` (which would break the round-trip).
 */
export function encodeEntityToken(type: EntitySheetType, id: string, label: string): string {
  const safe = label
    .replace(/[\r\n]+/g, ' ')
    .replace(/[|>]/g, '')
    .trim()
    .slice(0, 80);
  return `<@${type}:${id}|${safe}>`;
}
