import { describe, it, expect, vi } from 'vitest';
import { sweepDueSchedules, type ScheduleIndexStore } from './schedule-sweep';
import type { ScheduleIndexRow } from '../schedule-index';

// Thursday 2026-07-09 14:32:00 UTC
const NOW = Date.UTC(2026, 6, 9, 14, 32, 0);

function row(overrides: Partial<ScheduleIndexRow> = {}): ScheduleIndexRow {
  return {
    schedule_id: 'sched_1',
    workspace_id: 'org_test',
    workflow_id: 'wfl_1',
    trigger_id: null,
    cron_expression: '* * * * *',
    timezone: 'UTC',
    start_date: null,
    end_date: null,
    next_run_at: NOW - 60_000, // due a minute ago by default
    last_run_at: null,
    source: 'task',
    is_enabled: 1,
    updated_at: NOW,
    ...overrides,
  };
}

/** In-memory ScheduleIndexStore over a Map, mirroring the D1 impl's semantics. */
function fakeStore(rows: ScheduleIndexRow[]): ScheduleIndexStore & { rows: Map<string, ScheduleIndexRow> } {
  const map = new Map(rows.map((r) => [r.schedule_id, { ...r }]));
  return {
    rows: map,
    async dueRows(now) {
      return [...map.values()].filter(
        (r) => r.is_enabled === 1 && (r.next_run_at == null || r.next_run_at <= now),
      );
    },
    async setNextRun(id, nextRunAt, now) {
      const r = map.get(id);
      if (r) Object.assign(r, { next_run_at: nextRunAt, updated_at: now });
    },
    async disable(id, now) {
      const r = map.get(id);
      if (r) Object.assign(r, { is_enabled: 0, next_run_at: null, updated_at: now });
    },
    async markFired(id, nextRunAt, now) {
      const r = map.get(id);
      if (r) Object.assign(r, { next_run_at: nextRunAt, last_run_at: now, is_enabled: nextRunAt != null ? 1 : 0, updated_at: now });
    },
  };
}

describe('sweepDueSchedules', () => {
  it('dispatches a due schedule and advances its next_run_at + last_run_at', async () => {
    const store = fakeStore([row({ workflow_id: 'wfl_dispatch_me' })]);
    const execute = { create: vi.fn(async () => ({ id: 'inst_1' })) };
    const onFired = vi.fn(async () => {});

    const dispatched = await sweepDueSchedules(store, execute, onFired, NOW);

    expect(dispatched).toBe(1);
    expect(execute.create).toHaveBeenCalledWith({
      params: expect.objectContaining({
        workspaceId: 'org_test',
        userId: 'system',
        workflowId: 'wfl_dispatch_me',
        triggerType: 'schedule',
        source: 'task',
      }),
    });
    const r = store.rows.get('sched_1')!;
    expect(r.last_run_at).toBe(NOW);
    expect(r.next_run_at).toBe(NOW + 60_000); // "* * * * *" -> next minute
    expect(onFired).toHaveBeenCalledWith(expect.objectContaining({ schedule_id: 'sched_1' }), true, NOW + 60_000, NOW);
  });

  it('routes helpdesk-prefixed workflows to the helpdesk source', async () => {
    const store = fakeStore([row({ workflow_id: 'hwf_9', source: 'helpdesk' })]);
    const execute = { create: vi.fn(async () => ({})) };
    await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(execute.create).toHaveBeenCalledWith({ params: expect.objectContaining({ source: 'helpdesk' }) });
  });

  it('computes next_run_at for a row that needs it, without firing that tick', async () => {
    const store = fakeStore([row({ next_run_at: null, cron_expression: '0 9 * * *' })]);
    const execute = { create: vi.fn(async () => ({})) };

    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);

    expect(dispatched).toBe(0);
    expect(execute.create).not.toHaveBeenCalled();
    const r = store.rows.get('sched_1')!;
    // 09:00 UTC already passed at 14:32 -> next is tomorrow 09:00.
    expect(r.next_run_at).toBe(Date.UTC(2026, 6, 10, 9, 0, 0));
  });

  it('does not dispatch a not-yet-started schedule', async () => {
    const store = fakeStore([row({ start_date: NOW + 3_600_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(dispatched).toBe(0);
    expect(execute.create).not.toHaveBeenCalled();
  });

  it('disables a schedule whose endDate has passed', async () => {
    const store = fakeStore([row({ end_date: NOW - 3_600_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(execute.create).not.toHaveBeenCalled();
    expect(store.rows.get('sched_1')!.is_enabled).toBe(0);
  });

  it('respects the 55s double-fire guard', async () => {
    const store = fakeStore([row({ last_run_at: NOW - 10_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(dispatched).toBe(0);
    expect(execute.create).not.toHaveBeenCalled();
  });

  it('reports a failed dispatch to onFired(ok=false) and does not count it', async () => {
    const store = fakeStore([row()]);
    const execute = { create: vi.fn(async () => { throw new Error('boom'); }) };
    const onFired = vi.fn(async () => {});

    const dispatched = await sweepDueSchedules(store, execute, onFired, NOW);

    expect(dispatched).toBe(0);
    expect(onFired).toHaveBeenCalledWith(expect.any(Object), false, NOW + 60_000, NOW);
    // next_run_at is still advanced so it won't refire next tick.
    expect(store.rows.get('sched_1')!.next_run_at).toBe(NOW + 60_000);
  });

  it('skips (without error) when no EXECUTE_WORKFLOW binding is provided', async () => {
    const store = fakeStore([row()]);
    const dispatched = await sweepDueSchedules(store, undefined, async () => {}, NOW);
    expect(dispatched).toBe(0);
    // Not advanced — it should retry once a binding exists.
    expect(store.rows.get('sched_1')!.last_run_at).toBeNull();
  });
});
