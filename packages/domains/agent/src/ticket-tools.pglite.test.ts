/**
 * WeldAgent's ticket tools against a real tenant schema (pglite): a ticket the
 * AI opens lands in the WeldDesk inbox (desk_conversations), where the team
 * works, and an externalId keeps repeats on one ticket.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/notifications')>()),
  createAndDeliverNotification: vi.fn(async () => 'ntf'),
}));

const { PLATFORM_TOOLS } = await import('./tools');
type ToolContext = import('./tools').ToolContext;

const tool = (id: string) => PLATFORM_TOOLS.find((t) => t.id === id)!;

let db: Database;

const ctx = (): ToolContext => ({ db, agentId: 'agt_test', actorUserId: 'user_me', workspaceId: 'org_1' });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('ticket tools · the WeldDesk inbox', () => {
  it('opens a ticket as an inbox conversation and keeps a repeat on it', async () => {
    const first = (await tool('tickets.create').execute(ctx(), {
      subject: 'Refund for order 12',
      description: 'Jo was charged twice',
      customerName: 'Jo Customer',
      customerEmail: 'jo@example.com',
      priority: 'high',
      externalId: 'order-12',
    })) as { id: string; number: number; created: boolean };
    expect(first.id).toMatch(/^dconv_/);
    expect(first.created).toBe(true);

    const again = (await tool('tickets.create').execute(ctx(), {
      subject: 'Refund for order 12',
      description: 'Jo asked again',
      externalId: 'order-12',
    })) as { id: string; created: boolean };
    expect(again).toMatchObject({ id: first.id, created: false });

    const [row] = await db.select().from(schema.deskConversations);
    expect(row).toMatchObject({
      channel: 'api',
      state: 'open',
      email: 'jo@example.com',
      externalId: 'order-12',
      priority: 'high',
    });
    const messages = await db.select().from(schema.deskMessages);
    expect(messages.filter((m) => m.kind === 'message').map((m) => m.metadata?.via)).toEqual(['agent', 'agent']);
    // The priority is a ticket field, set by the agent as a bot on the timeline.
    expect(messages.find((m) => m.metadata?.eventType === 'attributes_changed')).toMatchObject({
      authorType: 'bot',
      authorId: 'agt_test',
    });

    const listed = (await tool('tickets.list').execute(ctx(), { search: 'refund' })) as {
      tickets: Array<{ id: string; subject: string | null; customerEmail: string | null }>;
    };
    expect(listed.tickets).toEqual([
      expect.objectContaining({ id: first.id, subject: 'Refund for order 12', customerEmail: 'jo@example.com' }),
    ]);
  });
});
