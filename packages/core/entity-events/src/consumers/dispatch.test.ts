import { describe, expect, it, vi } from 'vitest';
import type { EntityEventMessage } from '../types';
import { dispatch } from './dispatch';
import { defineConsumer, validateRegistry } from './registry';
import { matches, matchesOne, normalizeSubscription } from './match';
import type { EntityEventConsumer } from './types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeMessage {
  id: string;
  body: EntityEventMessage;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

let seq = 0;

function msg(
  eventType: `${string}:${string}`,
  workspaceId = 'ws_1',
  overrides: Partial<EntityEventMessage> = {},
): FakeMessage {
  const [entityType, action] = eventType.split(':') as [string, string];
  seq += 1;
  return {
    id: `m_${seq}`,
    body: {
      id: `evt_${seq}`,
      eventType,
      entityType,
      entityId: `ent_${seq}`,
      action,
      data: {},
      metadata: {
        workspaceId,
        userId: 'user_1',
        timestamp: '2026-08-06T00:00:00.000Z',
        source: 'api',
      },
      ...overrides,
    } as EntityEventMessage,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(messages: FakeMessage[]) {
  return { messages, queue: 'entity-events', retryAll: vi.fn(), ackAll: vi.fn() } as never;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('matching', () => {
  it('matches exact, entity-wildcard and global subscriptions', () => {
    expect(matchesOne('customer:created', 'customer:created')).toBe(true);
    expect(matchesOne('customer:created', 'customer:updated')).toBe(false);
    expect(matchesOne('customer:created', 'customer:*')).toBe(true);
    expect(matchesOne('customer:created', '*')).toBe(true);
    expect(matchesOne('customer:created', 'contact:*')).toBe(false);
  });

  it('does not let an entity-type prefix match a longer name', () => {
    expect(matchesOne('customer_note:created', 'customer:*')).toBe(false);
  });

  it('handles actions containing underscores', () => {
    expect(matchesOne('message:email_sent', 'message:email_sent')).toBe(true);
    expect(matchesOne('message:email_sent', 'message:*')).toBe(true);
  });

  it('accepts dotted subscriptions by normalising them', () => {
    expect(normalizeSubscription('customer.created')).toBe('customer:created');
    expect(matchesOne('customer:created', normalizeSubscription('customer.created'))).toBe(true);
  });

  it('matches one action across every entity type', () => {
    expect(matchesOne('customer:deleted', '*:deleted')).toBe(true);
    expect(matchesOne('ticket:deleted', '*:deleted')).toBe(true);
    expect(matchesOne('customer:created', '*:deleted')).toBe(false);
  });

  it('matches custom objects only under the co_ wildcard', () => {
    expect(matchesOne('co_machine:created', 'co_*')).toBe(true);
    expect(matchesOne('customer:created', 'co_*')).toBe(false);
    expect(matchesOne('co_machine:created', 'co_machine:created')).toBe(true);
  });

  it("treats '*' as subscribes-to-everything", () => {
    expect(matches('anything:at_all', '*')).toBe(true);
    expect(matches('anything:at_all', ['customer:*'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('defineConsumer', () => {
  const noop = { name: 'x', subscribes: ['customer:created'], handle: async () => {} };

  it('accepts catalog-valid subscriptions', () => {
    expect(() => defineConsumer(noop)).not.toThrow();
    expect(() => defineConsumer({ ...noop, subscribes: ['customer:*'] })).not.toThrow();
    expect(() => defineConsumer({ ...noop, subscribes: '*' })).not.toThrow();
    expect(() => defineConsumer({ ...noop, subscribes: ['co_*', 'co_machine:created'] })).not.toThrow();
    expect(() => defineConsumer({ ...noop, subscribes: ['*:deleted'] })).not.toThrow();
  });

  it("rejects '*:*' in favour of the plain wildcard", () => {
    expect(() => defineConsumer({ ...noop, subscribes: ['*:*'] })).toThrow(/rather than/);
  });

  it('rejects an unknown entity type', () => {
    expect(() => defineConsumer({ ...noop, subscribes: ['custmer:created'] })).toThrow(
      /not in the events catalog/,
    );
  });

  it('rejects an action the entity does not declare', () => {
    expect(() => defineConsumer({ ...noop, subscribes: ['customer:defenestrated'] })).toThrow(
      /no action "defenestrated"/,
    );
  });

  it('rejects a subscription with no action part', () => {
    expect(() => defineConsumer({ ...noop, subscribes: ['customer'] })).toThrow(/expected/);
  });

  it('rejects an empty subscription list', () => {
    expect(() => defineConsumer({ ...noop, subscribes: [] })).toThrow(/at least one event/);
  });

  it('rejects queue transport with no binding', () => {
    expect(() =>
      defineConsumer({ name: 'q', subscribes: '*', transport: 'queue', queueBinding: '' }),
    ).toThrow(/no queueBinding/);
  });

  it('normalises dotted subscriptions on the returned consumer', () => {
    const c = defineConsumer({ ...noop, subscribes: ['customer.created'] });
    expect(c.subscribes).toEqual(['customer:created']);
  });

  it('rejects duplicate names in a registry', () => {
    expect(() => validateRegistry([noop, { ...noop }] as EntityEventConsumer[])).toThrow(
      /duplicate consumer name/,
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('acks everything when the registry is empty (phase 1 shadow mode)', async () => {
    const a = msg('customer:created');
    const b = msg('ticket:created');
    await dispatch(batch([a, b]), { env: {}, consumers: [] });
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
  });

  it('hands each consumer only its matching events, grouped by workspace', async () => {
    const seen: Record<string, string[]> = {};
    const record = (name: string) =>
      defineConsumer({
        name,
        subscribes: name === 'all' ? '*' : ['customer:*'],
        async handle(events, ctx) {
          seen[name] ??= [];
          seen[name].push(...events.map((e) => `${ctx.workspaceId}/${e.eventType}`));
        },
      });

    const messages = [
      msg('customer:created', 'ws_1'),
      msg('ticket:created', 'ws_1'),
      msg('customer:updated', 'ws_2'),
    ];

    await dispatch(batch(messages), { env: {}, consumers: [record('all'), record('cust')] });

    expect(seen.cust!.sort()).toEqual(['ws_1/customer:created', 'ws_2/customer:updated']);
    expect(seen.all!.sort()).toEqual([
      'ws_1/customer:created',
      'ws_1/ticket:created',
      'ws_2/customer:updated',
    ]);
    messages.forEach((m) => expect(m.ack).toHaveBeenCalledOnce());
  });

  it('acks messages no consumer subscribes to', async () => {
    const unmatched = msg('ticket:created');
    await dispatch(batch([unmatched]), {
      env: {},
      consumers: [defineConsumer({ name: 'c', subscribes: ['customer:*'], handle: async () => {} })],
    });
    expect(unmatched.ack).toHaveBeenCalledOnce();
    expect(unmatched.retry).not.toHaveBeenCalled();
  });

  it('retries only the messages a failing consumer matched', async () => {
    const cust = msg('customer:created');
    const ticket = msg('ticket:created');

    await dispatch(batch([cust, ticket]), {
      env: {},
      consumers: [
        defineConsumer({
          name: 'boom',
          subscribes: ['customer:*'],
          handle: async () => {
            throw new Error('nope');
          },
        }),
        defineConsumer({ name: 'fine', subscribes: '*', handle: async () => {} }),
      ],
    });

    expect(cust.retry).toHaveBeenCalledOnce();
    expect(cust.ack).not.toHaveBeenCalled();
    // The healthy consumer's other message is unaffected.
    expect(ticket.ack).toHaveBeenCalledOnce();
    expect(ticket.retry).not.toHaveBeenCalled();
  });

  it('isolates consumers — one throwing does not stop the others running', async () => {
    const ran = vi.fn();
    const m = msg('customer:created');

    await dispatch(batch([m]), {
      env: {},
      consumers: [
        defineConsumer({
          name: 'boom',
          subscribes: '*',
          handle: async () => {
            throw new Error('nope');
          },
        }),
        defineConsumer({ name: 'ok', subscribes: '*', handle: async () => void ran() }),
      ],
    });

    expect(ran).toHaveBeenCalledOnce();
    expect(m.retry).toHaveBeenCalledOnce();
  });

  it('converts a synchronous throw in handle() into a retry', async () => {
    const m = msg('customer:created');
    await dispatch(batch([m]), {
      env: {},
      consumers: [
        {
          name: 'sync-boom',
          subscribes: '*',
          handle: (() => {
            throw new Error('sync');
          }) as never,
        },
      ],
    });
    expect(m.retry).toHaveBeenCalledOnce();
  });

  it('acks unroutable messages instead of looping them', async () => {
    const broken = msg('customer:created');
    broken.body.metadata.workspaceId = '';

    await dispatch(batch([broken]), {
      env: {},
      consumers: [defineConsumer({ name: 'c', subscribes: '*', handle: async () => {} })],
    });

    expect(broken.ack).toHaveBeenCalledOnce();
    expect(broken.retry).not.toHaveBeenCalled();
  });

  it('resolves the tenant DB once per workspace and shares it', async () => {
    const resolveTenantDb = vi.fn(async () => ({ tag: 'db' }) as never);
    const dbs: unknown[] = [];
    const collect = (name: string) =>
      defineConsumer({
        name,
        subscribes: '*',
        needsTenantDb: true,
        async handle(_events, ctx) {
          dbs.push(ctx.db);
        },
      });

    await dispatch(batch([msg('customer:created', 'ws_1'), msg('ticket:created', 'ws_1')]), {
      env: {},
      consumers: [collect('a'), collect('b')],
      resolveTenantDb,
    });

    expect(resolveTenantDb).toHaveBeenCalledOnce();
    expect(dbs).toHaveLength(2);
    expect(dbs[0]).toBe(dbs[1]);
  });

  it('does not resolve a tenant DB when no matching consumer needs one', async () => {
    const resolveTenantDb = vi.fn();
    await dispatch(batch([msg('customer:created')]), {
      env: {},
      consumers: [defineConsumer({ name: 'c', subscribes: '*', handle: async () => {} })],
      resolveTenantDb: resolveTenantDb as never,
    });
    expect(resolveTenantDb).not.toHaveBeenCalled();
  });

  it('retries a workspace whose DB will not resolve, so it reaches the DLQ', async () => {
    const m = msg('customer:created');
    await dispatch(batch([m]), {
      env: {},
      consumers: [
        defineConsumer({
          name: 'c',
          subscribes: '*',
          needsTenantDb: true,
          handle: async () => {},
        }),
      ],
      resolveTenantDb: async () => {
        throw new Error('workspace gone');
      },
    });
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('forwards a queue-transport consumer to its binding', async () => {
    const sendBatch = vi.fn(async () => {});
    const m = msg('customer:created');

    await dispatch(batch([m]), {
      env: { SEARCH_EVENTS: { sendBatch } },
      consumers: [
        defineConsumer({
          name: 'search',
          subscribes: '*',
          transport: 'queue',
          queueBinding: 'SEARCH_EVENTS',
        }),
      ],
    });

    expect(sendBatch).toHaveBeenCalledWith([{ body: m.body }]);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('retries rather than drops when a queue binding is missing', async () => {
    const m = msg('customer:created');
    await dispatch(batch([m]), {
      env: {},
      consumers: [
        defineConsumer({
          name: 'search',
          subscribes: '*',
          transport: 'queue',
          queueBinding: 'SEARCH_EVENTS',
        }),
      ],
    });
    expect(m.retry).toHaveBeenCalledOnce();
  });
});
