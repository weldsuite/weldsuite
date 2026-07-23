import { describe, it, expect, vi } from 'vitest';
import {
  deriveEventTypes,
  triggerMatchesEvent,
  matchAndDispatchWorkflowTriggers,
  evalFilters,
  integrationTriggerMatches,
  matchAndDispatchIntegrationTriggers,
} from './workflow-dispatch';

describe('deriveEventTypes', () => {
  it('returns just the action for non-update events', () => {
    expect(deriveEventTypes('created')).toEqual(['created']);
  });

  it('fans out updated into change-derived event types', () => {
    const types = deriveEventTypes('updated', {
      status: { old: 'open', new: 'closed' },
      assigneeId: { old: null, new: 'u1' },
      tags: { old: [], new: ['vip'] },
      priority: { old: 'low', new: 'high' },
    });
    expect(types).toEqual(['updated', 'status_changed', 'assigned', 'tagged', 'priority_changed']);
  });

  it('only adds the event types whose fields actually changed', () => {
    expect(deriveEventTypes('updated', { status: { old: 'a', new: 'b' } })).toEqual([
      'updated',
      'status_changed',
    ]);
  });
});

describe('triggerMatchesEvent', () => {
  const base = { type: 'entity_event', entityType: 'company', eventType: 'created' };

  it('matches entity type + event type', () => {
    expect(triggerMatchesEvent(base, 'company', ['created'], {})).toBe(true);
  });

  it('rejects a different entity type or event type', () => {
    expect(triggerMatchesEvent(base, 'person', ['created'], {})).toBe(false);
    expect(triggerMatchesEvent(base, 'company', ['updated'], {})).toBe(false);
  });

  it('ignores non-entity_event or disabled triggers', () => {
    expect(triggerMatchesEvent({ type: 'schedule' }, 'company', ['created'], {})).toBe(false);
    expect(triggerMatchesEvent({ ...base, isEnabled: false }, 'company', ['created'], {})).toBe(false);
  });

  it('reads entityType/eventType from the nested config too', () => {
    const t = { type: 'entity_event', config: { entityType: 'lead', eventType: 'created' } };
    expect(triggerMatchesEvent(t, 'lead', ['created'], {})).toBe(true);
  });

  it('applies config filters', () => {
    const t = {
      type: 'entity_event',
      entityType: 'company',
      eventType: 'created',
      config: { filters: [{ field: 'country', operator: 'eq', value: 'BE' }] },
    };
    expect(triggerMatchesEvent(t, 'company', ['created'], { country: 'BE' })).toBe(true);
    expect(triggerMatchesEvent(t, 'company', ['created'], { country: 'NL' })).toBe(false);
  });
});

describe('matchAndDispatchWorkflowTriggers', () => {
  function fakeDb(workflows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: async () => workflows }) }),
    } as any;
  }

  it('dispatches a CF Workflow for each matching trigger', async () => {
    const create = vi.fn(async () => undefined);
    const db = fakeDb([
      { id: 'wf_1', name: 'A', triggers: [{ type: 'entity_event', entityType: 'company', eventType: 'created' }] },
      { id: 'wf_2', name: 'B', triggers: [{ type: 'entity_event', entityType: 'person', eventType: 'created' }] },
    ]);

    await matchAndDispatchWorkflowTriggers({
      env: { EXECUTE_WORKFLOW: { create } },
      db,
      workspaceId: 'ws_1',
      userId: 'u1',
      entityType: 'company',
      entityId: 'company_1',
      action: 'created',
      data: {},
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ workflowId: 'wf_1', triggerType: 'entity_event', source: 'task' }),
      }),
    );
  });

  it('no-ops when the EXECUTE_WORKFLOW binding is absent', async () => {
    await expect(
      matchAndDispatchWorkflowTriggers({
        env: {},
        db: fakeDb([]),
        workspaceId: 'ws_1',
        userId: 'u1',
        entityType: 'company',
        entityId: 'c1',
        action: 'created',
        data: {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe('evalFilters', () => {
  it('passes when filters are empty/absent', () => {
    expect(evalFilters(undefined, {})).toBe(true);
    expect(evalFilters([], { a: 1 })).toBe(true);
  });

  it('applies eq/contains/exists operators', () => {
    expect(evalFilters([{ field: 'channel', operator: 'eq', value: 'C1' }], { channel: 'C1' })).toBe(true);
    expect(evalFilters([{ field: 'channel', operator: 'eq', value: 'C1' }], { channel: 'C2' })).toBe(false);
    expect(evalFilters([{ field: 'text', operator: 'contains', value: 'deploy' }], { text: 'please deploy now' })).toBe(true);
    expect(evalFilters([{ field: 'user', operator: 'exists', value: null }], { user: 'U1' })).toBe(true);
    expect(evalFilters([{ field: 'user', operator: 'exists', value: null }], {})).toBe(false);
  });
});

describe('integrationTriggerMatches', () => {
  const base = { type: 'integration_event', provider: 'slack', event: 'slack.message' };

  it('matches provider + event', () => {
    expect(integrationTriggerMatches(base, 'slack', 'slack.message', undefined, {})).toBe(true);
  });

  it('rejects a different provider or event', () => {
    expect(integrationTriggerMatches(base, 'google_sheets', 'slack.message', undefined, {})).toBe(false);
    expect(integrationTriggerMatches(base, 'slack', 'slack.slash_command', undefined, {})).toBe(false);
  });

  it('ignores non-integration_event or disabled triggers', () => {
    expect(integrationTriggerMatches({ type: 'entity_event' }, 'slack', 'slack.message', undefined, {})).toBe(false);
    expect(integrationTriggerMatches({ ...base, isEnabled: false }, 'slack', 'slack.message', undefined, {})).toBe(false);
  });

  it('reads provider/event from the nested config', () => {
    const t = { type: 'integration_event', config: { provider: 'slack', event: 'slack.message' } };
    expect(integrationTriggerMatches(t, 'slack', 'slack.message', undefined, {})).toBe(true);
  });

  it('honours a pinned integrationId', () => {
    const t = { ...base, integrationId: 'int_1' };
    expect(integrationTriggerMatches(t, 'slack', 'slack.message', 'int_1', {})).toBe(true);
    expect(integrationTriggerMatches(t, 'slack', 'slack.message', 'int_2', {})).toBe(false);
  });

  it('applies filters', () => {
    const t = { ...base, filters: [{ field: 'channel', operator: 'eq', value: 'C1' }] };
    expect(integrationTriggerMatches(t, 'slack', 'slack.message', undefined, { channel: 'C1' })).toBe(true);
    expect(integrationTriggerMatches(t, 'slack', 'slack.message', undefined, { channel: 'C2' })).toBe(false);
  });
});

describe('matchAndDispatchIntegrationTriggers', () => {
  function fakeDb(workflows: unknown[]) {
    return { select: () => ({ from: () => ({ where: async () => workflows }) }) } as any;
  }

  it('dispatches a CF Workflow for each matching integration trigger', async () => {
    const create = vi.fn(async () => undefined);
    const db = fakeDb([
      { id: 'wf_1', name: 'A', triggers: [{ type: 'integration_event', provider: 'slack', event: 'slack.message' }] },
      { id: 'wf_2', name: 'B', triggers: [{ type: 'integration_event', provider: 'google_sheets', event: 'google_sheets.new_row' }] },
    ]);

    await matchAndDispatchIntegrationTriggers({
      env: { EXECUTE_WORKFLOW: { create } },
      db,
      workspaceId: 'ws_1',
      userId: 'system',
      provider: 'slack',
      event: 'slack.message',
      integrationId: 'int_1',
      data: { channel: 'C1' },
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          workflowId: 'wf_1',
          triggerType: 'integration_event',
          source: 'integration',
        }),
      }),
    );
  });

  it('no-ops when the EXECUTE_WORKFLOW binding is absent', async () => {
    await expect(
      matchAndDispatchIntegrationTriggers({
        env: {},
        db: fakeDb([]),
        workspaceId: 'ws_1',
        userId: 'system',
        provider: 'slack',
        event: 'slack.message',
        data: {},
      }),
    ).resolves.toBeUndefined();
  });
});
