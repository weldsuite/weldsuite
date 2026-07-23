/**
 * WeldDesk v2 — macros service (saved replies + bundled actions).
 *
 * `applyMacro` is the only place that turns a macro's declarative
 * `DeskMacroAction[]` into real conversation mutations. It NEVER writes to
 * desk_conversations/desk_conversation_parts directly — every action goes
 * through appendPart (assign/close/snooze) or the same tag/attribute patch
 * shape the desk-conversations route uses, so the statistics rollup and
 * timeline stay consistent with manual actions.
 */

import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { DeskMacro, DeskMacroAction } from '@weldsuite/db/schema/desk-macros';
import type { DeskConversation } from '@weldsuite/db/schema/desk-conversations';
import type { DeskConversationPart } from '@weldsuite/db/schema/desk-conversation-parts';
import type { CreateDeskMacroInput, UpdateDeskMacroInput } from '@weldsuite/core-api-client/schemas/desk-macros';
import { appendPart, DeskConversationNotFoundError } from './parts';

const macros = schema.deskMacros;
const conversations = schema.deskConversations;

export class DeskMacroNotFoundError extends Error {
  constructor(id: string) {
    super(`Macro '${id}' not found`);
    this.name = 'DeskMacroNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Macros CRUD
// ---------------------------------------------------------------------------

export async function listDeskMacros(
  db: Database,
  options: { archived?: boolean; teamId?: string } = {},
): Promise<DeskMacro[]> {
  const includeArchived = options.archived ?? false;
  const rows = await db.select().from(macros).orderBy(asc(macros.name));
  return rows.filter((row) => {
    if (!includeArchived && row.archived) return false;
    if (options.teamId && row.teamIds && row.teamIds.length > 0 && !row.teamIds.includes(options.teamId)) {
      return false;
    }
    return true;
  });
}

export async function getDeskMacro(db: Database, id: string): Promise<DeskMacro | null> {
  const [row] = await db.select().from(macros).where(eq(macros.id, id)).limit(1);
  return row ?? null;
}

export async function createDeskMacro(
  db: Database,
  createdBy: string,
  input: CreateDeskMacroInput,
): Promise<DeskMacro> {
  const id = generateId('dmacro');
  const now = new Date();
  await db.insert(macros).values({
    id,
    createdAt: now,
    updatedAt: now,
    name: input.name,
    body: input.body ?? null,
    insertAs: input.insertAs ?? 'reply',
    actions: (input.actions ?? []) as DeskMacroAction[],
    teamIds: input.teamIds ?? null,
    createdBy,
    archived: false,
  });
  const [created] = await db.select().from(macros).where(eq(macros.id, id)).limit(1);
  return created!;
}

export async function updateDeskMacro(db: Database, id: string, input: UpdateDeskMacroInput): Promise<DeskMacro> {
  const current = await getDeskMacro(db, id);
  if (!current) throw new DeskMacroNotFoundError(id);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.body !== undefined) patch.body = input.body;
  if (input.insertAs !== undefined) patch.insertAs = input.insertAs;
  if (input.actions !== undefined) patch.actions = input.actions;
  if (input.teamIds !== undefined) patch.teamIds = input.teamIds;

  await db.update(macros).set(patch).where(eq(macros.id, id));
  const [updated] = await db.select().from(macros).where(eq(macros.id, id)).limit(1);
  return updated!;
}

/** Archive (soft-delete) — macros are never hard-deleted. */
export async function archiveDeskMacro(db: Database, id: string): Promise<DeskMacro> {
  const current = await getDeskMacro(db, id);
  if (!current) throw new DeskMacroNotFoundError(id);
  await db.update(macros).set({ archived: true, updatedAt: new Date() }).where(eq(macros.id, id));
  const [updated] = await db.select().from(macros).where(eq(macros.id, id)).limit(1);
  return updated!;
}

// ---------------------------------------------------------------------------
// Apply macro to a conversation
// ---------------------------------------------------------------------------

export interface ApplyMacroResult {
  conversation: DeskConversation;
  parts: DeskConversationPart[];
  /** Set when the macro has a reply/note body — client prefills the composer, does NOT auto-send. */
  composerPrefill?: { body: string; insertAs: 'reply' | 'note' };
  /** Actions the executor intentionally skipped (e.g. apply_sla — Phase 3). */
  skipped: { action: DeskMacroAction['type']; reason: string }[];
}

/**
 * Execute a macro's actions against a single conversation. Each action maps
 * to an appendPart call (assign/close/snooze) or a direct tag/customAttributes
 * patch — the same shape routes/desk-conversations/index.ts uses for tags and
 * attributes, kept here so both call sites stay in lockstep.
 */
export async function applyMacro(
  db: Database,
  conversationId: string,
  macroId: string,
  actorUserId: string,
): Promise<ApplyMacroResult> {
  const macro = await getDeskMacro(db, macroId);
  if (!macro) throw new DeskMacroNotFoundError(macroId);

  const [current] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!current) throw new DeskConversationNotFoundError(conversationId);

  const parts: DeskConversationPart[] = [];
  const skipped: ApplyMacroResult['skipped'] = [];
  let conversation: DeskConversation = current;

  for (const action of macro.actions) {
    switch (action.type) {
      case 'add_tag': {
        const tags = new Set(conversation.tags ?? []);
        tags.add(action.tag);
        await db
          .update(conversations)
          .set({ tags: Array.from(tags), updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
        break;
      }
      case 'remove_tag': {
        const tags = (conversation.tags ?? []).filter((tag) => tag !== action.tag);
        await db
          .update(conversations)
          .set({ tags, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
        break;
      }
      case 'assign': {
        const result = await appendPart(db, {
          conversationId,
          partType: conversation.state === 'snoozed' ? 'assign_and_unsnooze' : 'assignment',
          authorType: 'admin',
          authorId: actorUserId,
          assignedToType: action.assigneeType,
          assignedToId: action.assigneeId,
        });
        conversation = result.conversation;
        parts.push(result.part);
        break;
      }
      case 'close': {
        const result = await appendPart(db, {
          conversationId,
          partType: 'close',
          authorType: 'admin',
          authorId: actorUserId,
        });
        conversation = result.conversation;
        parts.push(result.part);
        break;
      }
      case 'snooze': {
        const snoozedUntil = new Date(Date.now() + action.durationMinutes * 60_000);
        const result = await appendPart(db, {
          conversationId,
          partType: 'snoozed',
          authorType: 'admin',
          authorId: actorUserId,
          snoozedUntil,
        });
        conversation = result.conversation;
        parts.push(result.part);
        break;
      }
      case 'mark_priority': {
        await db
          .update(conversations)
          .set({ priority: action.priority, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
        break;
      }
      case 'set_attribute': {
        const customAttributes = { ...(conversation.customAttributes ?? {}), [action.attributeId]: action.value };
        await db
          .update(conversations)
          .set({ customAttributes, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
        break;
      }
      case 'apply_sla': {
        // TODO(phase-3): SLA engine
        skipped.push({ action: 'apply_sla', reason: 'SLA engine lands in Phase 3' });
        break;
      }
      default: {
        // Exhaustiveness guard — DeskMacroAction is a closed union.
        const _never: never = action;
        void _never;
      }
    }
  }

  return {
    conversation,
    parts,
    composerPrefill: macro.body ? { body: macro.body, insertAs: macro.insertAs } : undefined,
    skipped,
  };
}
