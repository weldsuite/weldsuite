/**
 * The conversation is the ticket: type, priority, tags, team and the type's
 * custom fields on /api/desk/conversations, against pglite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskConversationsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDeskConversation, isPublicDeskMessage, type DeskMessage } from '@weldsuite/db/lib/desk';
import { syncTicketTypeDefinitions } from '@weldsuite/db/lib/custom-field-ticket-types';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

const appFor = (...keys: string[]) =>
  createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, userId: 'user_agent_1' },
  });

const patch = (id: string, body: unknown, keys = ['conversations:update']) =>
  appFor(...keys).request(`/api/desk/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const startConversation = async (visitorId: string, body = 'My invoice is wrong') =>
  (await createDeskConversation(db, { generateId, visitorId, name: 'Rita', body })).conversation;

interface PatchResult {
  data: {
    conversation: {
      id: string;
      ticketTypeId: string | null;
      priority: string | null;
      tags: string[];
      departmentId: string | null;
      customFields: Record<string, unknown>;
    };
    message: DeskMessage | null;
  };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.helpdeskTicketTypes).values([
    { id: 'tt_billing', name: 'Billing', createdAt: now, updatedAt: now, isActive: true },
    { id: 'tt_bug', name: 'Bug', createdAt: now, updatedAt: now, isActive: true },
    { id: 'tt_retired', name: 'Retired', createdAt: now, updatedAt: now, isActive: false },
  ]);
  await syncTicketTypeDefinitions(db, generateId, 'tt_billing', [
    { key: 'invoice_number', label: 'Invoice number', type: 'text', required: true, order: 0 },
    {
      key: 'plan',
      label: 'Plan',
      type: 'select',
      required: false,
      order: 1,
      options: [
        { label: 'Free', value: 'free' },
        { label: 'Pro', value: 'pro' },
      ],
    },
  ]);
  await syncTicketTypeDefinitions(db, generateId, 'tt_bug', [
    { key: 'steps', label: 'Steps to reproduce', type: 'textarea', required: false, order: 0 },
  ]);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dep_finance', name: 'Finance', createdAt: now, updatedAt: now, isActive: true },
    { id: 'dep_closed', name: 'Old team', createdAt: now, updatedAt: now, isActive: false },
  ]);
}, 60_000);

describe('PATCH /api/desk/conversations/:id · ticket fields', () => {
  it('sets type, priority, tags, team and custom fields, and logs one internal event', async () => {
    const conversation = await startConversation('visitor_attr_all');
    const res = await patch(conversation.id, {
      ticketTypeId: 'tt_billing',
      priority: 'high',
      tags: ['  Refund ', 'vip', 'refund'],
      departmentId: 'dep_finance',
      customFields: { invoice_number: 'INV-42', plan: 'pro' },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as PatchResult;

    expect(data.conversation).toMatchObject({
      ticketTypeId: 'tt_billing',
      priority: 'high',
      tags: ['Refund', 'vip'],
      departmentId: 'dep_finance',
      customFields: { invoice_number: 'INV-42', plan: 'pro' },
    });
    expect(data.message).toMatchObject({ kind: 'event', authorType: 'agent', authorId: 'user_agent_1' });
    const changes = data.message?.metadata?.changes as Array<{ field: string; to: unknown }>;
    expect(changes.map((ch) => ch.field)).toEqual(['ticketType', 'team', 'priority', 'tags', 'customField', 'customField']);
    expect(changes.find((ch) => ch.field === 'ticketType')?.to).toBe('Billing');
    expect(changes.find((ch) => ch.field === 'team')?.to).toBe('Finance');
    // Ticket-field changes never reach the visitor's widget.
    expect(isPublicDeskMessage(data.message as DeskMessage)).toBe(false);

    const detail = await appFor('conversations:read').request(`/api/desk/conversations/${conversation.id}`);
    const body = (await detail.json()) as { data: { customFields: Record<string, unknown> } };
    expect(body.data.customFields).toEqual({ invoice_number: 'INV-42', plan: 'pro' });
  });

  it('writes nothing when nothing changes', async () => {
    const conversation = await startConversation('visitor_attr_same');
    await patch(conversation.id, { priority: 'low', tags: ['a', 'b'] });
    const res = await patch(conversation.id, { priority: 'low', tags: ['a', 'b'] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as PatchResult;
    expect(data.message).toBeNull();
  });

  it('clears fields with null and an empty tag list', async () => {
    const conversation = await startConversation('visitor_attr_clear');
    await patch(conversation.id, { priority: 'urgent', departmentId: 'dep_finance', tags: ['x'] });
    const res = await patch(conversation.id, { priority: null, departmentId: null, tags: [] });
    const { data } = (await res.json()) as PatchResult;
    expect(data.conversation).toMatchObject({ priority: null, departmentId: null, tags: [] });
  });

  it('shows only the new type\'s fields after the type changes', async () => {
    const conversation = await startConversation('visitor_attr_switch');
    await patch(conversation.id, { ticketTypeId: 'tt_billing', customFields: { invoice_number: 'INV-1' } });
    const res = await patch(conversation.id, { ticketTypeId: 'tt_bug', customFields: { steps: 'Click pay' } });
    const { data } = (await res.json()) as PatchResult;
    expect(data.conversation.customFields).toEqual({ steps: 'Click pay' });
  });

  it('refuses an unknown or inactive type and team', async () => {
    const conversation = await startConversation('visitor_attr_refs');
    for (const body of [
      { ticketTypeId: 'tt_missing' },
      { ticketTypeId: 'tt_retired' },
      { departmentId: 'dep_closed' },
    ]) {
      const res = await patch(conversation.id, body);
      expect(res.status).toBe(400);
    }
  });

  it('refuses a field the type does not have and a value outside a select', async () => {
    const conversation = await startConversation('visitor_attr_fields');
    await patch(conversation.id, { ticketTypeId: 'tt_billing' });
    expect((await patch(conversation.id, { customFields: { steps: 'x' } })).status).toBe(400);
    expect((await patch(conversation.id, { customFields: { plan: 'enterprise' } })).status).toBe(400);
  });

  it('refuses an empty body and needs conversations:update', async () => {
    const conversation = await startConversation('visitor_attr_perm');
    expect((await patch(conversation.id, {})).status).toBe(400);
    expect((await patch(conversation.id, { priority: 'low' }, ['conversations:read'])).status).toBe(403);
  });

  it('answers 404 for a conversation that does not exist', async () => {
    expect((await patch('dconv_missing', { priority: 'low' })).status).toBe(404);
  });
});

describe('GET /api/desk/conversations · ticket field filters', () => {
  it('filters by priority, type, team and tag', async () => {
    const urgent = await startConversation('visitor_filter_a', 'Site is down');
    const plain = await startConversation('visitor_filter_b', 'Just a question');
    await patch(urgent.id, {
      priority: 'urgent',
      ticketTypeId: 'tt_bug',
      departmentId: 'dep_finance',
      tags: ['outage'],
    });

    const ids = async (query: string) => {
      const res = await appFor('conversations:read').request(`/api/desk/conversations?${query}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      return body.data.map((row) => row.id);
    };

    expect(await ids('priority=urgent')).toContain(urgent.id);
    expect(await ids('priority=urgent')).not.toContain(plain.id);
    expect(await ids('priority=none')).toContain(plain.id);
    expect(await ids('priority=none')).not.toContain(urgent.id);
    expect(await ids('ticketTypeId=tt_bug')).toContain(urgent.id);
    expect(await ids('departmentId=dep_finance')).toContain(urgent.id);
    expect(await ids('tag=outage')).toEqual([urgent.id]);
  });
});

describe('GET /api/desk/conversations/attributes', () => {
  it('lists active types, their fields, active teams and tags in use', async () => {
    const res = await appFor('conversations:read').request('/api/desk/conversations/attributes');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        ticketTypes: Array<{ id: string }>;
        teams: Array<{ id: string }>;
        fields: Array<{ ticketTypeId: string | null; slug: string; fieldType: string; required: boolean }>;
        tags: Array<{ tag: string; count: number }>;
      };
    };
    expect(data.ticketTypes.map((t) => t.id)).toEqual(['tt_billing', 'tt_bug']);
    expect(data.teams.map((t) => t.id)).toEqual(['dep_finance']);
    expect(data.fields).toContainEqual(
      expect.objectContaining({ ticketTypeId: 'tt_billing', slug: 'plan', fieldType: 'single_select', required: false }),
    );
    expect(data.tags).toContainEqual({ tag: 'outage', count: 1 });
  });
});
