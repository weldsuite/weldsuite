import { describe, expect, it, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { auditConsumer } from './audit';
import type { Env } from '../env';

function event(overrides: Partial<EntityEventMessage> = {}): EntityEventMessage {
  return {
    id: 'evt_1',
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { name: 'Acme' },
    metadata: {
      workspaceId: 'ws_1',
      userId: 'user_1',
      timestamp: '2026-08-06T00:00:00.000Z',
      source: 'api',
    },
    ...overrides,
  } as EntityEventMessage;
}

type AuditRow = Record<string, unknown>;

/** Minimal stand-in for the two Drizzle chains the consumer uses. */
function fakeDb(members: Array<{ userId: string; name: string | null }> = []) {
  const onConflictDoNothing = vi.fn(async (_target?: unknown) => undefined);
  const values = vi.fn((_rows: AuditRow[]) => ({ onConflictDoNothing }));
  const insert = vi.fn((_table?: unknown) => ({ values }));
  const where = vi.fn(async () => members);
  const select = vi.fn((_cols?: unknown) => ({ from: () => ({ where }) }));
  return { db: { insert, select } as never, insert, values, onConflictDoNothing, select, where };
}

/** The rows handed to the single insert. */
const insertedRows = (values: ReturnType<typeof fakeDb>['values']): AuditRow[] =>
  values.mock.calls[0]![0];

const ctx = (db: unknown) => ({ env: {} as Env, workspaceId: 'ws_1', db: db as never });

function handle(consumer: typeof auditConsumer) {
  if (consumer.transport === 'queue') throw new Error('audit should be an inline consumer');
  return consumer.handle;
}

describe('audit consumer', () => {
  it('inserts one row per event in a single statement', async () => {
    const f = fakeDb([{ userId: 'user_1', name: 'Jane Doe' }]);
    await handle(auditConsumer)([event(), event({ id: 'evt_2', entityId: 'cus_2' })], ctx(f.db));

    expect(f.insert).toHaveBeenCalledOnce();
    const rows = insertedRows(f.values);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eventId)).toEqual(['evt_1', 'evt_2']);
  });

  it('carries the event id onto the row so the unique index can dedupe', async () => {
    const f = fakeDb();
    await handle(auditConsumer)([event({ id: 'evt_abc' })], ctx(f.db));

    const rows = insertedRows(f.values);
    expect(rows[0]!.eventId).toBe('evt_abc');
    expect(f.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('resolves actor names once for the whole batch', async () => {
    const f = fakeDb([{ userId: 'user_1', name: 'Jane Doe' }]);
    await handle(auditConsumer)(
      [event(), event({ id: 'evt_2' }), event({ id: 'evt_3' })],
      ctx(f.db),
    );

    expect(f.select).toHaveBeenCalledOnce();
    const rows = insertedRows(f.values);
    expect(rows.every((r) => r.performedByName === 'Jane Doe')).toBe(true);
    expect(rows[0]!.description).toBe("'Acme' was created by Jane Doe");
  });

  it('falls back to System when the actor has no member row', async () => {
    const f = fakeDb([]);
    await handle(auditConsumer)([event()], ctx(f.db));

    const rows = insertedRows(f.values);
    expect(rows[0]!.performedByName).toBeNull();
    expect(rows[0]!.description).toBe("'Acme' was created by System");
  });

  it('still writes the batch when the name lookup fails', async () => {
    const f = fakeDb();
    f.where.mockRejectedValueOnce(new Error('lookup exploded'));

    await handle(auditConsumer)([event()], ctx(f.db));

    expect(f.insert).toHaveBeenCalledOnce();
  });

  it('propagates an insert failure so the batch retries', async () => {
    const f = fakeDb();
    f.onConflictDoNothing.mockRejectedValueOnce(new Error('db down'));

    await expect(handle(auditConsumer)([event()], ctx(f.db))).rejects.toThrow('db down');
  });

  it('throws rather than writing to the wrong place when no db was resolved', async () => {
    await expect(
      handle(auditConsumer)([event()], { env: {} as Env, workspaceId: 'ws_1' }),
    ).rejects.toThrow(/requires a tenant db/);
  });
});
