import { describe, expect, it } from 'vitest';
import {
  listDueCrmSyncIndex,
  markCrmSyncIndexTriggered,
  upsertCrmSyncIndex,
  type CrmSyncIndexRow,
} from './crm-sync-index';

function memoryD1() {
  const rows = new Map<string, CrmSyncIndexRow>();
  return {
    rows,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (query.includes('INSERT INTO crm_sync_index')) {
                const [
                  connectionId,
                  workspaceId,
                  clerkOrgId,
                  provider,
                  enabled,
                  nextDue,
                  intervalMinutes,
                  renewWatchAt,
                  now,
                  dueNow,
                ] = values as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  number,
                  number | null,
                  number,
                  number,
                ];
                const existing = rows.get(connectionId);
                if (!existing) {
                  rows.set(connectionId, {
                    connection_id: connectionId,
                    workspace_id: workspaceId,
                    clerk_org_id: clerkOrgId,
                    provider,
                    enabled,
                    next_due_at: nextDue,
                    interval_minutes: intervalMinutes,
                    renew_watch_at: renewWatchAt,
                    last_triggered_at: null,
                    last_error: null,
                    updated_at: now,
                  });
                } else {
                  rows.set(connectionId, {
                    ...existing,
                    workspace_id: workspaceId,
                    clerk_org_id: clerkOrgId,
                    provider,
                    enabled,
                    interval_minutes: intervalMinutes,
                    renew_watch_at: renewWatchAt ?? existing.renew_watch_at,
                    next_due_at: enabled === 0 ? existing.next_due_at : dueNow === 1 ? nextDue : existing.next_due_at,
                    updated_at: now,
                  });
                }
              }
              if (query.includes('UPDATE crm_sync_index') && query.includes('last_triggered_at')) {
                const [nextDue, lastTriggered, lastError, renewWatchAt, now, connectionId] = values as [
                  number,
                  number,
                  string | null,
                  number | null,
                  number,
                  string,
                ];
                const existing = rows.get(connectionId);
                if (existing) {
                  rows.set(connectionId, {
                    ...existing,
                    next_due_at: nextDue,
                    last_triggered_at: lastTriggered,
                    last_error: lastError,
                    renew_watch_at: renewWatchAt ?? existing.renew_watch_at,
                    updated_at: now,
                  });
                }
              }
              return {};
            },
            async all<T>() {
              if (query.includes('SELECT * FROM crm_sync_index')) {
                const [now, limit] = values as [number, number];
                const results = [...rows.values()]
                  .filter((r) => r.enabled === 1 && r.next_due_at <= now)
                  .sort((a, b) => a.next_due_at - b.next_due_at)
                  .slice(0, limit);
                return { results: results as T[] };
              }
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

describe('crm-sync-index', () => {
  it('lists only due enabled rows and advances after trigger', async () => {
    const d1 = memoryD1();
    await upsertCrmSyncIndex(d1, {
      connectionId: 'intc_1',
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      provider: 'attio',
      enabled: true,
      intervalMinutes: 360,
      dueNow: true,
      now: 1_000,
    });
    await upsertCrmSyncIndex(d1, {
      connectionId: 'intc_2',
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      provider: 'hubspot',
      enabled: true,
      intervalMinutes: 360,
      dueNow: false,
      now: 1_000,
    });

    const due = await listDueCrmSyncIndex(d1, 1_000);
    expect(due.map((r) => r.connection_id)).toEqual(['intc_1']);

    await markCrmSyncIndexTriggered(d1, {
      connectionId: 'intc_1',
      intervalMinutes: 360,
      now: 1_000,
    });
    expect((await listDueCrmSyncIndex(d1, 1_000)).length).toBe(0);
    expect(d1.rows.get('intc_1')!.next_due_at).toBe(1_000 + 360 * 60_000);
  });
});
