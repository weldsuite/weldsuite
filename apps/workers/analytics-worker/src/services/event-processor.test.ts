import { describe, expect, it } from 'vitest';
import { transformEvent } from './event-processor';
import type { EntityEventMessage } from '../lib/entity-events';

const event = (entityType: string, action: string, data: Record<string, unknown>): EntityEventMessage =>
  ({
    id: 'evt_1',
    entityType,
    entityId: 'dconv_1',
    action,
    data,
    metadata: { workspaceId: 'ws_1', userId: 'user_1', timestamp: '2026-03-10T09:30:00.000Z' },
  }) as unknown as EntityEventMessage;

const conversation = {
  id: 'dconv_1',
  state: 'open',
  channel: 'email',
  priority: 'high',
  ticketTypeId: 'tt_1',
  assigneeId: 'user_ann',
  departmentId: 'dep_1',
  slaStatus: 'paused',
  email: 'rita@example.com',
  name: 'Rita',
  createdAt: '2026-03-10T09:00:00.000Z',
  updatedAt: '2026-03-10T09:30:00.000Z',
  lastMessageAt: '2026-03-10T09:30:00.000Z',
  firstResponseAt: '2026-03-10T09:30:00.000Z',
  firstResponseSeconds: 1800,
  resolvedAt: null,
  resolutionSeconds: null,
};

describe('desk events into analytics', () => {
  it('maps an inbox conversation to a helpdesk row with its ticket fields', () => {
    const record = transformEvent(event('desk_conversation', 'updated', conversation));
    expect(record).toMatchObject({
      workspace_id: 'ws_1',
      module: 'helpdesk',
      entity_type: 'desk_conversation',
      action: 'updated',
      event_date: '2026-03-10',
      status: 'open',
      priority: 'high',
      channel: 'email',
      category: 'tt_1',
      assignee_id: 'user_ann',
      stage: 'dep_1',
      sub_status: 'paused',
      is_completed: 0,
      is_escalated: 0,
    });
    // No personal data reaches the analytics row.
    expect(JSON.stringify(record)).not.toContain('rita');
  });

  it('carries the first response time only on the append that recorded it', () => {
    const first = transformEvent(event('desk_conversation', 'updated', conversation));
    expect(first.response_time_seconds).toBe(1800);

    const later = transformEvent(
      event('desk_conversation', 'updated', {
        ...conversation,
        updatedAt: '2026-03-10T10:00:00.000Z',
        lastMessageAt: '2026-03-10T10:00:00.000Z',
      }),
    );
    expect(later.response_time_seconds).toBeUndefined();
  });

  it('carries the resolution time on the close, and flags a breached SLA', () => {
    const closed = transformEvent(
      event('desk_conversation', 'state_changed', {
        ...conversation,
        state: 'closed',
        slaStatus: 'breached',
        updatedAt: '2026-03-10T13:00:00.000Z',
        resolvedAt: '2026-03-10T13:00:00.000Z',
        resolutionSeconds: 14_400,
      }),
    );
    expect(closed).toMatchObject({ status: 'closed', is_completed: 1, is_escalated: 1, resolution_time_seconds: 14_400 });
    expect(closed.response_time_seconds).toBeUndefined();
  });

  it('maps inbox messages to helpdesk rows, and other desk_ entities to helpdesk', () => {
    expect(
      transformEvent(event('desk_message', 'created', { kind: 'message', authorType: 'agent', body: 'Hi Rita' })),
    ).toMatchObject({ module: 'helpdesk', entity_type: 'desk_message', status: 'message', category: 'agent' });
    expect(transformEvent(event('desk_widget', 'updated', {}))).toMatchObject({ module: 'helpdesk', entity_type: 'desk_widget' });
  });

  it('still reads a status check from `status` for the other entities', () => {
    expect(transformEvent(event('activity', 'updated', { status: 'done' })).is_completed).toBe(1);
  });
});
