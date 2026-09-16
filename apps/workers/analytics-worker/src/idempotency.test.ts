import { describe, it, expect } from 'vitest';
import { shouldProcessEventId } from './index';
import { transformEvent } from './services/event-processor';
import type { EntityEventMessage } from './lib/entity-events';

function sampleEvent(id = 'evt_abc'): EntityEventMessage {
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

describe('shouldProcessEventId (Phase 2 in-batch idempotency)', () => {
  it('accepts the first occurrence and rejects duplicates in the same batch', () => {
    const seen = new Set<string>();
    expect(shouldProcessEventId(seen, 'evt_1')).toBe(true);
    expect(shouldProcessEventId(seen, 'evt_1')).toBe(false);
    expect(shouldProcessEventId(seen, 'evt_2')).toBe(true);
    expect(seen.size).toBe(2);
  });
});

describe('transformEvent event_id', () => {
  it('copies message.id onto the analytics record for lineage', () => {
    const record = transformEvent(sampleEvent('evt_lineage'));
    expect(record.event_id).toBe('evt_lineage');
  });
});
