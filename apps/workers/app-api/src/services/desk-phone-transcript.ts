/**
 * Sync Telnyx AI conversation history into WeldDesk messages.
 *
 * Telnyx sends the *full* history on every `call.ai_gather.message_history_updated`
 * webhook. We append new turns and patch the last turn when its text grows
 * (partial → final).
 */

import { eq } from 'drizzle-orm';
import {
  appendDeskMessage,
  type DeskMessage,
} from '@weldsuite/db/lib/desk';
import type { DeskAuthorType, DeskMessageKind } from '@weldsuite/db/schema/desk-messages';
import type { Database } from '../db';
import { schema } from '../db';
import { generateId } from '../lib/id';

export interface AiTalkTurn {
  role?: string;
  content?: unknown;
}

export interface TranscriptSyncResult {
  appended: DeskMessage[];
  updated: DeskMessage[];
}

const TRANSCRIPT_EVENT = 'ai_transcript';

function turnContent(item: AiTalkTurn): string {
  if (typeof item.content === 'string') return item.content.trim();
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  if (item.content && typeof item.content === 'object') {
    const rec = item.content as { text?: unknown; transcript?: unknown };
    if (typeof rec.text === 'string') return rec.text.trim();
    if (typeof rec.transcript === 'string') return rec.transcript.trim();
  }
  return '';
}

function authorForRole(role: string): { authorType: DeskAuthorType; kind: DeskMessageKind } {
  const r = role.toLowerCase();
  if (r === 'user' || r === 'customer' || r === 'caller') {
    return { authorType: 'visitor', kind: 'message' };
  }
  if (r === 'tool' || r === 'function') {
    return { authorType: 'bot', kind: 'note' };
  }
  return { authorType: 'bot', kind: 'message' };
}

export function extractTranscriptTurns(
  existing: DeskMessage[],
  callId: string,
): Map<number, DeskMessage> {
  const map = new Map<number, DeskMessage>();
  for (const msg of existing) {
    const meta = msg.metadata as Record<string, unknown> | null;
    if (meta?.event !== TRANSCRIPT_EVENT) continue;
    if (meta.callId !== callId) continue;
    const idx = meta.turnIndex;
    if (typeof idx === 'number') map.set(idx, msg);
  }
  return map;
}

export async function syncAiTalkTranscript(
  db: Database,
  args: {
    conversationId: string;
    callId: string;
    voiceAgentId?: string | null;
    visitorId?: string | null;
    history: AiTalkTurn[];
    existingMessages: DeskMessage[];
  },
): Promise<TranscriptSyncResult> {
  const existing = extractTranscriptTurns(args.existingMessages, args.callId);
  const appended: DeskMessage[] = [];
  const updated: DeskMessage[] = [];

  for (let i = 0; i < args.history.length; i += 1) {
    const item = args.history[i]!;
    const body = turnContent(item);
    if (!body) continue;
    const role = String(item.role || 'assistant');
    const prev = existing.get(i);
    if (!prev) {
      const { authorType, kind } = authorForRole(role);
      const result = await appendDeskMessage(db, {
        generateId,
        conversationId: args.conversationId,
        kind,
        authorType,
        authorId:
          authorType === 'visitor'
            ? args.visitorId ?? null
            : args.voiceAgentId ?? null,
        body,
        metadata: {
          event: TRANSCRIPT_EVENT,
          callId: args.callId,
          turnIndex: i,
          role,
        },
      });
      appended.push(result.message);
      continue;
    }
    if (prev.body !== body) {
      const [row] = await db
        .update(schema.deskMessages)
        .set({ body })
        .where(eq(schema.deskMessages.id, prev.id))
        .returning();
      if (row) updated.push(row);
    }
  }

  return { appended, updated };
}

export function parseMessageHistory(payload: Record<string, unknown>): AiTalkTurn[] {
  const raw =
    payload.message_history ??
    payload.messages ??
    payload.history ??
    (payload.conversation && typeof payload.conversation === 'object'
      ? (payload.conversation as { messages?: unknown }).messages
      : null);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is AiTalkTurn => Boolean(item) && typeof item === 'object');
}
