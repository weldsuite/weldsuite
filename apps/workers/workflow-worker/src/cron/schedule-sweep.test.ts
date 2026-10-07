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
    schedule_type: 'recurring',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    start_date: null,
    end_date: null,
    execute_at: null,
    next_run_at: NOW - 60_000, // due a minute ago by default
    last_run_at: null,
    source: 'weldconnect',
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
        source: 'weldconnect',
      }),
    });
    const r = store.rows.get('sched_1')!;
    expect(r.last_run_at).toBe(NOW);
    expect(r.next_run_at).toBe(NOW + 60_000); // "* * * * *" -> next minute
    expect(onFired).toHaveBeenCalledWith(expect.objectContaining({ schedule_id: 'sched_1' }), true, NOW + 60_000, NOW);
  });

  it('passes the due slot (floored to the minute) and the schedule timezone as trigger data', async () => {
    const slot = Date.UTC(2026, 6, 9, 14, 31, 0);
    const store = fakeStore([row({ next_run_at: slot + 500, timezone: 'Europe/Amsterdam' })]);
    const execute = { create: vi.fn(async () => ({})) };
    await sweepDueSchedules(store, execute, async () => {}, NOW + 20_878);
    const call = execute.create.mock.calls[0] as unknown as [{ params: { triggerData: Record<string, unknown> } }];
    const { params } = call[0];
    expect(params.triggerData.scheduledTime).toBe('2026-07-09T14:31:00.000Z');
    expect(params.triggerData.timezone).toBe('Europe/Amsterdam');
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

describe('sweepDueSchedules — one-time schedules', () => {
  function onceRow(overrides: Partial<ScheduleIndexRow> = {}): ScheduleIndexRow {
    return row({
      schedule_type: 'one_time',
      cron_expression: '',
      execute_at: NOW - 60_000,
      next_run_at: null,
      ...overrides,
    });
  }

  it('materializes next_run_at from execute_at without firing that tick', async () => {
    const store = fakeStore([onceRow()]);
    const execute = { create: vi.fn(async () => ({})) };

    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);

    expect(dispatched).toBe(0);
    expect(execute.create).not.toHaveBeenCalled();
    expect(store.rows.get('sched_1')!.next_run_at).toBe(NOW - 60_000);
  });

  it('fires exactly once, then disables itself permanently (no next_run_at)', async () => {
    const store = fakeStore([onceRow({ next_run_at: NOW - 60_000 })]);
    const execute = { create: vi.fn(async () => ({ id: 'inst_1' })) };
    const onFired = vi.fn(async () => {});

    const dispatched = await sweepDueSchedules(store, execute, onFired, NOW);

    expect(dispatched).toBe(1);
    expect(execute.create).toHaveBeenCalledOnce();
    const fired = store.rows.get('sched_1')!;
    expect(fired.next_run_at).toBeNull();
    expect(fired.is_enabled).toBe(0);
    expect(onFired).toHaveBeenCalledWith(expect.objectContaining({ schedule_id: 'sched_1' }), true, null, NOW);

    // A second sweep tick (e.g. an overlapping/late invocation) must not refire it:
    // dueRows() only returns is_enabled=1 rows, and this one is now disabled.
    const dispatchedAgain = await sweepDueSchedules(store, execute, onFired, NOW + 60_000);
    expect(dispatchedAgain).toBe(0);
    expect(execute.create).toHaveBeenCalledOnce();
  });

  it('respects the 55s double-fire guard like a recurring schedule', async () => {
    const store = fakeStore([onceRow({ next_run_at: NOW - 60_000, last_run_at: NOW - 10_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(dispatched).toBe(0);
    expect(execute.create).not.toHaveBeenCalled();
  });

  it('disables a malformed one-time row (no execute_at) instead of looping forever', async () => {
    const store = fakeStore([onceRow({ execute_at: null, next_run_at: null })]);
    const execute = { create: vi.fn(async () => ({})) };
    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(dispatched).toBe(0);
    expect(store.rows.get('sched_1')!.is_enabled).toBe(0);
  });
});

describe('sweepDueSchedules — concurrency gate', () => {
  it('skips dispatch when checkConcurrency disallows it, but still advances timing', async () => {
    const store = fakeStore([row({ next_run_at: NOW - 60_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    const onFired = vi.fn(async () => {});
    const checkConcurrency = vi.fn(async () => ({ allowed: false }));

    const dispatched = await sweepDueSchedules(store, execute, onFired, NOW, checkConcurrency);

    expect(dispatched).toBe(0);
    expect(execute.create).not.toHaveBeenCalled();
    expect(checkConcurrency).toHaveBeenCalledWith(expect.objectContaining({ schedule_id: 'sched_1' }), NOW);
    // Recurring: still advances to its normal next tick, same as any other fire.
    expect(store.rows.get('sched_1')!.next_run_at).toBe(NOW + 60_000);
    expect(onFired).toHaveBeenCalledWith(expect.any(Object), false, NOW + 60_000, NOW);
  });

  it('dispatches normally when checkConcurrency allows it', async () => {
    const store = fakeStore([row({ next_run_at: NOW - 60_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    const checkConcurrency = vi.fn(async () => ({ allowed: true }));

    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW, checkConcurrency);

    expect(dispatched).toBe(1);
    expect(execute.create).toHaveBeenCalledOnce();
  });

  it('defaults to always-allowed when no checkConcurrency is passed', async () => {
    const store = fakeStore([row({ next_run_at: NOW - 60_000 })]);
    const execute = { create: vi.fn(async () => ({})) };
    const dispatched = await sweepDueSchedules(store, execute, async () => {}, NOW);
    expect(dispatched).toBe(1);
  });
});
