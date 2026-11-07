/**
 * Impact, urgency and the priority matrix on PATCH /api/desk/conversations/:id,
 * against pglite: the two fields on their own, the priority the grid derives
 * when the workspace has it on, a direct priority as an override, and the
 * grid in GET /attributes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDeskConversation, type DeskMessage } from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';
import { deskConversationsRoutes } from './index';

let db: Database;

const appFor = (...keys: string[]) =>
  createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, userId: 'user_agent_1' },
  });

const patch = (id: string, body: unknown) =>
  appFor('conversations:update').request(`/api/desk/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const start = async (visitorId: string) =>
  (await createDeskConversation(db, { generateId, visitorId, name: 'Mo', body: 'Checkout fails' })).conversation;

interface PatchResult {
  data: {
    conversation: { id: string; impact: string | null; urgency: string | null; priority: string | null };
    message: DeskMessage | null;
  };
}

const read = async (res: Response) => {
  expect(res.status).toBe(200);
  return ((await res.json()) as PatchResult).data;
};

const fields = (message: DeskMessage | null) =>
  ((message?.metadata?.changes ?? []) as Array<{ field: string; from: unknown; to: unknown }>).map(
    ({ field, from, to }) => ({ field, from, to }),
  );

const GRID = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'urgent' },
};

async function setMatrix(enabled: boolean) {
  await db.delete(schema.helpdeskSettings);
  const now = new Date();
  await db.insert(schema.helpdeskSettings).values({
    id: 'hds_matrix',
    tickets: { defaultPriority: 'low', priorityMatrix: { enabled, matrix: GRID } } as never,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('PATCH /api/desk/conversations/:id · impact and urgency', () => {
  it('sets and clears them without touching the priority while the matrix is off', async () => {
    await setMatrix(false);
    const conversation = await start('visitor_matrix_off');
    const set = await read(await patch(conversation.id, { impact: 'high', urgency: 'high' }));
    expect(set.conversation).toMatchObject({ impact: 'high', urgency: 'high', priority: null });
    expect(fields(set.message)).toEqual([
      { field: 'impact', from: null, to: 'high' },
      { field: 'urgency', from: null, to: 'high' },
    ]);

    const cleared = await read(await patch(conversation.id, { urgency: null }));
    expect(cleared.conversation).toMatchObject({ impact: 'high', urgency: null });
    expect(fields(cleared.message)).toEqual([{ field: 'urgency', from: 'high', to: null }]);
  });

  it('derives the priority from the grid once both are set, in the same event', async () => {
    await setMatrix(true);
    const conversation = await start('visitor_matrix_on');
    const half = await read(await patch(conversation.id, { impact: 'high' }));
    expect(half.conversation.priority).toBeNull();

    const both = await read(await patch(conversation.id, { urgency: 'medium' }));
    expect(both.conversation).toMatchObject({ impact: 'high', urgency: 'medium', priority: 'high' });
    expect(fields(both.message)).toEqual([
      { field: 'urgency', from: null, to: 'medium' },
      { field: 'priority', from: null, to: 'high' },
    ]);

    const raised = await read(await patch(conversation.id, { urgency: 'high' }));
    expect(raised.conversation.priority).toBe('urgent');
  });

  it('keeps a direct priority as an override until impact or urgency change again', async () => {
    await setMatrix(true);
    const conversation = await start('visitor_matrix_override');
    await patch(conversation.id, { impact: 'low', urgency: 'low' });
    const override = await read(await patch(conversation.id, { priority: 'urgent' }));
    expect(override.conversation).toMatchObject({ impact: 'low', urgency: 'low', priority: 'urgent' });

    const again = await read(await patch(conversation.id, { impact: 'medium' }));
    expect(again.conversation.priority).toBe('low');

    // A priority sent with the change wins over the grid.
    const both = await read(await patch(conversation.id, { impact: 'high', priority: 'medium' }));
    expect(both.conversation).toMatchObject({ impact: 'high', priority: 'medium' });
  });

  it('refuses a value outside low, medium and high', async () => {
    const conversation = await start('visitor_matrix_bad');
    expect((await patch(conversation.id, { impact: 'urgent' })).status).toBe(400);
    expect((await patch(conversation.id, { urgency: 'critical' })).status).toBe(400);
  });

  it('writes nothing when impact and urgency stay the same', async () => {
    await setMatrix(true);
    const conversation = await start('visitor_matrix_same');
    await patch(conversation.id, { impact: 'medium', urgency: 'medium' });
    const same = await read(await patch(conversation.id, { impact: 'medium', urgency: 'medium' }));
    expect(same.message).toBeNull();
    const [row] = await db
      .select({ priority: schema.deskConversations.priority })
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, conversation.id));
    expect(row?.priority).toBe('medium');
  });
});

describe('GET /api/desk/conversations/attributes · priority matrix', () => {
  it('answers the workspace grid and whether it is on', async () => {
    await setMatrix(true);
    const res = await appFor('conversations:read').request('/api/desk/conversations/attributes');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { priorityMatrix: unknown } };
    expect(data.priorityMatrix).toEqual({ enabled: true, matrix: GRID });
  });

  it('answers the default grid, off, without settings', async () => {
    await db.delete(schema.helpdeskSettings);
    const res = await appFor('conversations:read').request('/api/desk/conversations/attributes');
    const { data } = (await res.json()) as { data: { priorityMatrix: unknown } };
    expect(data.priorityMatrix).toEqual({ enabled: false, matrix: GRID });
  });
});
