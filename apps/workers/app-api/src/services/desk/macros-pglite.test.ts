/**
 * pglite-backed service tests for services/desk/macros.ts — CRUD + archive,
 * and `applyMacro` executing actions via the parts service (assign/close/
 * snooze land as parts; tag/priority/attribute land as direct patches;
 * apply_sla is skipped with a TODO reason).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  applyMacro,
  archiveDeskMacro,
  createDeskMacro,
  DeskMacroNotFoundError,
  listDeskMacros,
  updateDeskMacro,
} from './macros';
import { createConversation } from './conversations';
import { DeskConversationNotFoundError } from './parts';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedConversation() {
  const { conversation } = await createConversation(db, {
    channel: 'messenger',
    deliveredAs: 'admin_initiated',
    body: 'Hello',
    authorUserId: 'user_admin_1',
  });
  return conversation;
}

describe('desk macros · pglite integration', () => {
  it('creates, updates, and archives a macro', async () => {
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Close and tag',
      insertAs: 'reply',
      actions: [{ type: 'add_tag', tag: 'resolved' }, { type: 'close' }],
    });
    expect(macro.id).toMatch(/^dmacro_/);
    expect(macro.actions).toHaveLength(2);

    const updated = await updateDeskMacro(db, macro.id, { name: 'Close & tag resolved' });
    expect(updated.name).toBe('Close & tag resolved');

    const archived = await archiveDeskMacro(db, macro.id);
    expect(archived.archived).toBe(true);

    const activeOnly = await listDeskMacros(db);
    expect(activeOnly.some((m) => m.id === macro.id)).toBe(false);
    const withArchived = await listDeskMacros(db, { archived: true });
    expect(withArchived.some((m) => m.id === macro.id)).toBe(true);
  });

  it('update throws DeskMacroNotFoundError for a missing macro', async () => {
    await expect(updateDeskMacro(db, 'dmacro_missing', { name: 'x' })).rejects.toThrow(DeskMacroNotFoundError);
  });

  it('applyMacro: add_tag + mark_priority land as direct conversation patches', async () => {
    const conv = await seedConversation();
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Flag VIP',
      insertAs: 'reply',
      actions: [{ type: 'add_tag', tag: 'vip' }, { type: 'mark_priority', priority: true }],
    });

    const result = await applyMacro(db, conv.id, macro.id, 'user_admin_1');
    expect(result.conversation.tags).toContain('vip');
    expect(result.conversation.priority).toBe(true);
    expect(result.parts).toHaveLength(0); // no appendPart-backed actions in this macro
    expect(result.skipped).toHaveLength(0);
  });

  it('applyMacro: assign + close land as parts via appendPart', async () => {
    const conv = await seedConversation();
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Assign and close',
      insertAs: 'reply',
      actions: [
        { type: 'assign', assigneeType: 'admin', assigneeId: 'user_admin_2' },
        { type: 'close' },
      ],
    });

    const result = await applyMacro(db, conv.id, macro.id, 'user_admin_1');
    expect(result.conversation.adminAssigneeId).toBe('user_admin_2');
    expect(result.conversation.state).toBe('closed');
    expect(result.parts.map((p) => p.partType)).toEqual(['assignment', 'close']);
  });

  it('applyMacro: snooze lands as a snoozed part with a future snoozedUntil', async () => {
    const conv = await seedConversation();
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Snooze an hour',
      insertAs: 'reply',
      actions: [{ type: 'snooze', durationMinutes: 60 }],
    });

    const result = await applyMacro(db, conv.id, macro.id, 'user_admin_1');
    expect(result.conversation.state).toBe('snoozed');
    expect(result.conversation.snoozedUntil).toBeInstanceOf(Date);
    expect(result.conversation.snoozedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('applyMacro: set_attribute merges into customAttributes', async () => {
    const conv = await seedConversation();
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Set plan tier',
      insertAs: 'reply',
      actions: [{ type: 'set_attribute', attributeId: 'plan_tier', value: 'gold' }],
    });

    const result = await applyMacro(db, conv.id, macro.id, 'user_admin_1');
    expect(result.conversation.customAttributes).toMatchObject({ plan_tier: 'gold' });
  });

  it('applyMacro: apply_sla is skipped with a phase-3 TODO reason', async () => {
    const conv = await seedConversation();
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Apply gold SLA',
      insertAs: 'reply',
      actions: [{ type: 'apply_sla', slaId: 'sla_gold' }],
    });

    const result = await applyMacro(db, conv.id, macro.id, 'user_admin_1');
    expect(result.skipped).toEqual([{ action: 'apply_sla', reason: expect.stringContaining('Phase 3') }]);
  });

  it('applyMacro: composerPrefill is set when the macro has a body, and never auto-sends', async () => {
    const conv = await seedConversation();
    const macro = await createDeskMacro(db, 'user_admin_1', {
      name: 'Canned thanks',
      body: 'Thanks for reaching out!',
      insertAs: 'reply',
      actions: [],
    });

    const result = await applyMacro(db, conv.id, macro.id, 'user_admin_1');
    expect(result.composerPrefill).toEqual({ body: 'Thanks for reaching out!', insertAs: 'reply' });
    // No comment/reply part was appended — only a prefill hint returned.
    expect(result.parts).toHaveLength(0);
  });

  it('applyMacro throws DeskConversationNotFoundError for a missing conversation', async () => {
    const macro = await createDeskMacro(db, 'user_admin_1', { name: 'Noop', insertAs: 'reply', actions: [] });
    await expect(applyMacro(db, 'dconv_missing', macro.id, 'user_admin_1')).rejects.toThrow(
      DeskConversationNotFoundError,
    );
  });

  it('applyMacro throws DeskMacroNotFoundError for a missing macro', async () => {
    const conv = await seedConversation();
    await expect(applyMacro(db, conv.id, 'dmacro_missing', 'user_admin_1')).rejects.toThrow(DeskMacroNotFoundError);
  });
});
