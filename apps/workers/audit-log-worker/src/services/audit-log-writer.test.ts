import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  schema: {
    auditLogs: {
      id: 'audit_logs.id',
      metadata: 'audit_logs.metadata',
    },
    workspaceMembers: {
      name: 'workspace_members.name',
      userId: 'workspace_members.user_id',
    },
  },
}));

vi.mock('../lib/id', () => ({
  generateId: () => 'aud_test',
}));

import { writeAuditLogFromEvent } from './audit-log-writer';
import type { EntityEventMessage } from '../lib/entity-events';

function sampleEvent(id = 'evt_dup01'): EntityEventMessage {
  return {
    id,
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { id: 'cus_1', name: 'Acme' },
    metadata: {
      workspaceId: 'ws_1',
      userId: 'usr_1',
      timestamp: '2026-03-15T12:00:00.000Z',
      source: 'system',
    },
  };
}

function mockDb(options: { existingId?: string | null }) {
  const insertValues = vi.fn();
  const limit = vi.fn(async () =>
    options.existingId ? [{ id: options.existingId }] : [],
  );
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const insert = vi.fn(() => ({
    values: vi.fn((row: unknown) => {
      insertValues(row);
      return Promise.resolve();
    }),
  }));

  return {
    db: { select, insert } as never,
    select,
    insert,
    insertValues,
  };
}

describe('writeAuditLogFromEvent Phase 2 idempotency', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('skips insert when metadata.eventId already matches event.id', async () => {
    const { db, insert } = mockDb({ existingId: 'aud_existing' });
    const result = await writeAuditLogFromEvent(db, sampleEvent('evt_dup01'));
    expect(result).toBe('duplicate');
    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts when no prior row shares the event id', async () => {
    const { db, insert, insertValues } = mockDb({ existingId: null });
    const result = await writeAuditLogFromEvent(db, sampleEvent('evt_new01'));
    expect(result).toBe('written');
    expect(insert).toHaveBeenCalled();
    const row = insertValues.mock.calls[0]![0] as {
      metadata: { eventId: string };
    };
    expect(row.metadata.eventId).toBe('evt_new01');
  });
});
