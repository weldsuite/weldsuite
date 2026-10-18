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

describe('audit log descriptions', () => {
  it('phrases non-CRUD actions instead of appending "ed"', async () => {
    const { buildDescription } = await import('./audit-log-writer');
    expect(buildDescription('stage_changed', 'opportunity', 'Zeta renewal deal', 'Jane', null)).toBe(
      "'Zeta renewal deal' was moved to another stage by Jane",
    );
    expect(buildDescription('won', 'opportunity', 'Zeta renewal deal', 'Jane', null)).toBe(
      "'Zeta renewal deal' was marked as won by Jane",
    );
    expect(buildDescription('lost', 'opportunity', 'Zeta', null, null)).toBe("'Zeta' was marked as lost by System");
    expect(buildDescription('some_new_thing', 'opportunity', 'Zeta', 'Jane', null)).toBe(
      "'Zeta' was some new thing by Jane",
    );
  });
});

describe('getEntityDisplayName', () => {
  it('finds a name for entity types without their own field list', async () => {
    const { getEntityDisplayName } = await import('./audit-log-writer');
    expect(getEntityDisplayName('pipeline_stage', { name: 'Negotiation' })).toBe('Negotiation');
    expect(getEntityDisplayName('chat_channel', { name: 'general' })).toBe('general');
    expect(getEntityDisplayName('meeting', { title: 'Weekly sync' })).toBe('Weekly sync');
    expect(getEntityDisplayName('vat_return', { periodLabel: 'Q3 2026', status: 'draft' })).toBe('Q3 2026');
    expect(getEntityDisplayName('accounting_contact', { companyName: 'Acme BV' })).toBe('Acme BV');
  });

  it('joins first and last name', async () => {
    const { getEntityDisplayName } = await import('./audit-log-writer');
    expect(getEntityDisplayName('contact', { firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
    expect(getEntityDisplayName('person', { displayName: 'J. Doe', firstName: 'Jane' })).toBe('J. Doe');
  });

  it('returns null when nothing usable is there', async () => {
    const { getEntityDisplayName } = await import('./audit-log-writer');
    expect(getEntityDisplayName('vat_return', { id: 'vat_1', status: 'draft' })).toBeNull();
    expect(getEntityDisplayName('company', null)).toBeNull();
  });
});
