/**
 * WeldDesk auto-assignment: the settings routes (/api/desk/assignment) and the
 * shared assignment flow (`@weldsuite/db/lib/desk-assignment`) on pglite.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createDeskConversation } from '@weldsuite/db/lib/desk';
import {
  EMPTY_DESK_PICKER_STATE,
  autoAssignDeskConversation,
  pickDeskAssignee,
  saveDeskAssignmentSettings,
  setDeskMemberAway,
  type DeskAssigneePicker,
  type DeskPickerState,
} from '@weldsuite/db/lib/desk-assignment';
import { helpdeskSettingsRoutes } from '../helpdesk-settings';
import { deskAssignmentRoutes } from './index';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_ann', userId: 'user_ann', name: 'Ann' },
    { id: 'wm_bob', userId: 'user_bob', name: 'Bob' },
    { id: 'wm_cat', userId: 'user_cat', name: 'Cat' },
    { id: 'wm_gone', userId: 'user_gone', name: 'Gone', status: 'REMOVED' },
  ]);
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.helpdeskSettings);
});

const app = (userId: string, ...perms: string[]) =>
  createTestApp('/api/desk/assignment', deskAssignmentRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db, userId },
  }).request;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function newConversation(visitorId: string) {
  return (await createDeskConversation(db, { generateId, visitorId, body: `Hi from ${visitorId}` })).conversation;
}

/** In-process stand-in for the AssignmentRouter: same rule, state kept here. */
function routerPicker(): DeskAssigneePicker {
  let state: DeskPickerState = EMPTY_DESK_PICKER_STATE;
  return async (request) => {
    const result = pickDeskAssignee(state, request);
    state = result.state;
    return result.userId;
  };
}

describe('pickDeskAssignee', () => {
  const candidates = [
    { userId: 'b', open: 0 },
    { userId: 'a', open: 0 },
    { userId: 'c', open: 0 },
  ];

  it('round robin goes round in a stable order', () => {
    let state = EMPTY_DESK_PICKER_STATE;
    const picks: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const r = pickDeskAssignee(state, { mode: 'round_robin', candidates, maxOpen: null }, 1_000 + i * 60_000);
      picks.push(r.userId);
      state = r.state;
    }
    expect(picks).toEqual(['a', 'b', 'c', 'a']);
  });

  it('balanced takes the least loaded, counting picks made seconds ago', () => {
    const loaded = [
      { userId: 'a', open: 3 },
      { userId: 'b', open: 1 },
      { userId: 'c', open: 1 },
    ];
    const first = pickDeskAssignee(EMPTY_DESK_PICKER_STATE, { mode: 'balanced', candidates: loaded, maxOpen: null }, 0);
    expect(first.userId).toBe('b');
    // Same snapshot again a second later: b's pick still counts, so c is next.
    const second = pickDeskAssignee(first.state, { mode: 'balanced', candidates: loaded, maxOpen: null }, 1_000);
    expect(second.userId).toBe('c');
  });

  it('skips anyone at the cap and returns null when everyone is', () => {
    const full = [
      { userId: 'a', open: 2 },
      { userId: 'b', open: 1 },
    ];
    expect(pickDeskAssignee(EMPTY_DESK_PICKER_STATE, { mode: 'round_robin', candidates: full, maxOpen: 2 }).userId).toBe('b');
    expect(pickDeskAssignee(EMPTY_DESK_PICKER_STATE, { mode: 'round_robin', candidates: full, maxOpen: 1 }).userId).toBeNull();
  });
});

describe('/api/desk/assignment', () => {
  it('starts off with nobody in the rotation', async () => {
    const res = await app('user_ann', 'conversations:read')('/api/desk/assignment');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { mode: string; memberIds: string[]; me: { away: boolean } } };
    expect(data.mode).toBe('off');
    expect(data.memberIds).toEqual([]);
    expect(data.me.away).toBe(false);
  });

  it('needs settings:update to change the rules', async () => {
    const res = await app('user_ann', 'conversations:update')(
      '/api/desk/assignment',
      json('PUT', { mode: 'round_robin', memberIds: ['user_ann'], maxOpenPerMember: null }),
    );
    expect(res.status).toBe(403);
  });

  it('saves the rules, and an agent toggling away keeps them', async () => {
    const admin = app('user_ann', 'settings:update', 'conversations:update', 'conversations:read');
    const saved = await admin(
      '/api/desk/assignment',
      json('PUT', { mode: 'balanced', memberIds: ['user_ann', 'user_bob', 'user_ann'], maxOpenPerMember: 5 }),
    );
    expect(saved.status).toBe(200);

    const bob = app('user_bob', 'conversations:update', 'conversations:read');
    const away = await bob('/api/desk/assignment/away', json('POST', { away: true }));
    const { data } = (await away.json()) as {
      data: { mode: string; memberIds: string[]; awayMemberIds: string[]; maxOpenPerMember: number; me: { away: boolean; inRotation: boolean } };
    };
    expect(data).toMatchObject({
      mode: 'balanced',
      memberIds: ['user_ann', 'user_bob'],
      awayMemberIds: ['user_bob'],
      maxOpenPerMember: 5,
      me: { away: true, inRotation: true },
    });

    // The admin saving again doesn't bring Bob back.
    await admin('/api/desk/assignment', json('PUT', { mode: 'round_robin', memberIds: ['user_ann', 'user_bob'], maxOpenPerMember: null }));
    const back = await bob('/api/desk/assignment/away', json('POST', { away: false }));
    const after = (await back.json()) as { data: { mode: string; awayMemberIds: string[] } };
    expect(after.data.mode).toBe('round_robin');
    expect(after.data.awayMemberIds).toEqual([]);
  });

  it('the legacy automation form no longer wipes the assignment rules', async () => {
    await saveDeskAssignmentSettings(db, generateId, { mode: 'round_robin', memberIds: ['user_ann'] });
    const { request } = createTestApp('/api/helpdesk-settings', helpdeskSettingsRoutes, {
      context: { permissions: permissions('settings:update'), tenantDb: db },
    });
    const res = await request('/api/helpdesk-settings/automation', json('PUT', { enabled: true }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.helpdeskSettings);
    expect(row?.automation?.enabled).toBe(true);
    expect(row?.automation?.deskAssignment?.memberIds).toEqual(['user_ann']);
  });
});

describe('/api/desk/assignment refusals and edges', () => {
  it('needs conversations:read to read the settings', async () => {
    const res = await app('user_ann', 'settings:update', 'conversations:update')('/api/desk/assignment');
    expect(res.status).toBe(403);
  });

  it('rejects an unknown mode, bad member ids and a cap out of range', async () => {
    const admin = app('user_ann', 'settings:update');
    for (const body of [
      { mode: 'random', memberIds: [], maxOpenPerMember: null },
      { mode: 'balanced', memberIds: [''], maxOpenPerMember: null },
      { mode: 'balanced', memberIds: ['x'.repeat(256)], maxOpenPerMember: null },
      { mode: 'balanced', memberIds: Array.from({ length: 501 }, (_, i) => `user_${i}`), maxOpenPerMember: null },
      { mode: 'balanced', memberIds: 'user_ann', maxOpenPerMember: null },
      { mode: 'balanced', memberIds: [], maxOpenPerMember: 0 },
      { mode: 'balanced', memberIds: [], maxOpenPerMember: 1001 },
      { mode: 'balanced', memberIds: [], maxOpenPerMember: 2.5 },
      { mode: 'balanced', memberIds: [] },
    ]) {
      const res = await admin('/api/desk/assignment', json('PUT', body));
      expect(res.status).toBe(400);
    }
    expect(await db.select().from(schema.helpdeskSettings)).toHaveLength(0);
  });

  it('creates the settings row on the first save and answers where the caller stands', async () => {
    const res = await app('user_cat', 'settings:update')(
      '/api/desk/assignment',
      json('PUT', { mode: 'round_robin', memberIds: ['user_ann', 'user_bob'], maxOpenPerMember: 1000 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        mode: 'round_robin',
        memberIds: ['user_ann', 'user_bob'],
        awayMemberIds: [],
        maxOpenPerMember: 1000,
        me: { inRotation: false, away: false },
      },
    });
    const [row] = await db.select().from(schema.helpdeskSettings);
    expect(row?.automation).toMatchObject({ enabled: false, deskAssignment: { mode: 'round_robin', maxOpenPerMember: 1000 } });
  });

  it('reads saved settings, a member in the rotation who is away included', async () => {
    await saveDeskAssignmentSettings(db, generateId, { mode: 'balanced', memberIds: ['user_ann', 'user_bob'], maxOpenPerMember: 3 });
    await setDeskMemberAway(db, generateId, 'user_bob', true);
    const res = await app('user_bob', 'conversations:read')('/api/desk/assignment');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        mode: 'balanced',
        memberIds: ['user_ann', 'user_bob'],
        awayMemberIds: ['user_bob'],
        maxOpenPerMember: 3,
        me: { inRotation: true, away: true },
      },
    });
  });

  it('away needs conversations:update and a boolean', async () => {
    expect((await app('user_ann', 'conversations:read', 'settings:update')('/api/desk/assignment/away', json('POST', { away: true }))).status).toBe(403);
    for (const body of [{}, { away: 'yes' }, { away: 1 }]) {
      const res = await app('user_ann', 'conversations:update')('/api/desk/assignment/away', json('POST', body));
      expect(res.status).toBe(400);
    }
  });

  it('coming back without any settings saved answers the defaults and writes nothing', async () => {
    const res = await app('user_ann', 'conversations:update')('/api/desk/assignment/away', json('POST', { away: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { mode: 'off', memberIds: [], awayMemberIds: [], maxOpenPerMember: null, me: { inRotation: false, away: false } },
    });
    expect(await db.select().from(schema.helpdeskSettings)).toHaveLength(0);
  });

  it('going away without any settings saved creates the row', async () => {
    const res = await app('user_ann', 'conversations:update')('/api/desk/assignment/away', json('POST', { away: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { mode: 'off', memberIds: [], awayMemberIds: ['user_ann'], maxOpenPerMember: null, me: { inRotation: false, away: true } },
    });
    expect(await db.select().from(schema.helpdeskSettings)).toHaveLength(1);

    // Going away twice keeps one entry.
    const again = await app('user_ann', 'conversations:update')('/api/desk/assignment/away', json('POST', { away: true }));
    expect(((await again.json()) as { data: { awayMemberIds: string[] } }).data.awayMemberIds).toEqual(['user_ann']);
  });
});

describe('autoAssignDeskConversation', () => {
  it('does nothing while auto-assignment is off', async () => {
    const conversation = await newConversation('v_off');
    expect(await autoAssignDeskConversation(db, { generateId, conversationId: conversation.id, pick: routerPicker() })).toBeNull();
  });

  it('hands new conversations round the rotation and writes a system event', async () => {
    await saveDeskAssignmentSettings(db, generateId, {
      mode: 'round_robin',
      memberIds: ['user_ann', 'user_bob', 'user_gone'],
      maxOpenPerMember: null,
    });
    const pick = routerPicker();
    const owners: (string | null)[] = [];
    for (const visitor of ['v1', 'v2', 'v3']) {
      const conversation = await newConversation(visitor);
      const result = await autoAssignDeskConversation(db, { generateId, conversationId: conversation.id, pick });
      owners.push(result?.conversation.assigneeId ?? null);
      expect(result?.message).toMatchObject({
        kind: 'event',
        authorType: 'system',
        metadata: { eventType: 'assigned', auto: true },
      });
    }
    // user_gone isn't an active member, so it never comes up.
    expect(owners).toEqual(['user_ann', 'user_bob', 'user_ann']);
  });

  it('balanced mode, away teammates and the cap', async () => {
    await saveDeskAssignmentSettings(db, generateId, {
      mode: 'balanced',
      memberIds: ['user_ann', 'user_bob', 'user_cat'],
      maxOpenPerMember: 1,
    });
    await setDeskMemberAway(db, generateId, 'user_cat', true);
    const pick = routerPicker();

    const first = await newConversation('vb1');
    const second = await newConversation('vb2');
    const third = await newConversation('vb3');
    const a = await autoAssignDeskConversation(db, { generateId, conversationId: first.id, pick });
    const b = await autoAssignDeskConversation(db, { generateId, conversationId: second.id, pick });
    const c = await autoAssignDeskConversation(db, { generateId, conversationId: third.id, pick });

    expect(new Set([a?.conversation.assigneeId, b?.conversation.assigneeId])).toEqual(new Set(['user_ann', 'user_bob']));
    // Cat is away, and Ann and Bob are at their cap of one: it waits in Unassigned.
    expect(c).toBeNull();
  });

  it('never re-assigns an owned or closed conversation', async () => {
    await saveDeskAssignmentSettings(db, generateId, { mode: 'round_robin', memberIds: ['user_ann'], maxOpenPerMember: null });
    const conversation = await newConversation('v_owned');
    const pick = routerPicker();
    expect(await autoAssignDeskConversation(db, { generateId, conversationId: conversation.id, pick })).not.toBeNull();
    expect(await autoAssignDeskConversation(db, { generateId, conversationId: conversation.id, pick })).toBeNull();
    const events = await db.select().from(schema.deskMessages);
    expect(events.filter((m) => m.kind === 'event')).toHaveLength(1);
  });
});
