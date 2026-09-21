import { describe, expect, it } from 'vitest';
import {
  listDueTenantWorkIndex,
  markTenantWorkIndexRan,
  triggersIncludeWorkflowPoll,
  upsertTenantWorkIndex,
  type TenantWorkIndexRow,
} from './tenant-work-index';

function memoryD1() {
  const rows = new Map<string, TenantWorkIndexRow>();
  return {
    rows,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (query.includes('INSERT INTO tenant_work_index')) {
                const [
                  id,
                  workspaceId,
                  clerkOrgId,
                  kind,
                  enabled,
                  nextDueAt,
                  metadata,
                  now,
                ] = values as [
                  string,
                  string,
                  string,
                  TenantWorkIndexRow['kind'],
                  number,
                  number,
                  string | null,
                  number,
                ];
                const key = `${workspaceId}:${kind}`;
                const existing = rows.get(key);
                if (!existing) {
                  rows.set(key, {
                    id,
                    workspace_id: workspaceId,
                    clerk_org_id: clerkOrgId,
                    kind,
                    enabled,
                    next_due_at: nextDueAt,
                    metadata,
                    last_run_at: null,
                    last_error: null,
                    updated_at: now,
                  });
                } else {
                  rows.set(key, {
                    ...existing,
                    clerk_org_id: clerkOrgId,
                    enabled,
                    next_due_at: Math.min(existing.next_due_at, nextDueAt),
                    metadata: metadata ?? existing.metadata,
                    updated_at: now,
                  });
                }
              }
              if (query.includes('SET enabled = 0')) {
                const [lastRun, lastError, now, workspaceId, kind] = values as [
                  number,
                  string | null,
                  number,
                  string,
                  string,
                ];
                const key = `${workspaceId}:${kind}`;
                const existing = rows.get(key);
                if (existing) {
                  rows.set(key, {
                    ...existing,
                    enabled: 0,
                    last_run_at: lastRun,
                    last_error: lastError,
                    updated_at: now,
                  });
                }
              } else if (query.includes('SET next_due_at = ?') && query.includes('enabled = 1')) {
                const [nextDue, lastRun, lastError, now, workspaceId, kind] = values as [
                  number,
                  number,
                  string | null,
                  number,
                  string,
                  string,
                ];
                const key = `${workspaceId}:${kind}`;
                const existing = rows.get(key);
                if (existing) {
                  rows.set(key, {
                    ...existing,
                    next_due_at: nextDue,
                    last_run_at: lastRun,
                    last_error: lastError,
                    enabled: 1,
                    updated_at: now,
                  });
                }
              }
            },
            async all<T>() {
              if (query.includes('SELECT * FROM tenant_work_index')) {
                const [kind, now, limit] = values as [string, number, number];
                const results = [...rows.values()]
                  .filter((r) => r.enabled === 1 && r.kind === kind && r.next_due_at <= now)
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

describe('triggersIncludeWorkflowPoll', () => {
  it('detects Sheets / Gmail / Calendar / Airtable poll events', () => {
    expect(
      triggersIncludeWorkflowPoll([
        { type: 'integration_event', provider: 'gmail', event: 'gmail.new_email' },
      ]),
    ).toBe(true);
    expect(
      triggersIncludeWorkflowPoll([
        {
          type: 'integration_event',
          config: { provider: 'google_sheets', event: 'google_sheets.new_row' },
        },
      ]),
    ).toBe(true);
    expect(
      triggersIncludeWorkflowPoll([{ type: 'manual' }, { type: 'entity_event', entityType: 'task' }]),
    ).toBe(false);
    expect(
      triggersIncludeWorkflowPoll([
        { type: 'integration_event', provider: 'gmail', event: 'gmail.new_email', isEnabled: false },
      ]),
    ).toBe(false);
  });
});

describe('tenant_work_index idle drop', () => {
  it('disables a row when markTenantWorkIndexRan gets nextDueAt null', async () => {
    const d1 = memoryD1();
    await upsertTenantWorkIndex(d1, {
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      kind: 'webhook_retry',
      nextDueAt: 1000,
      now: 1000,
    });

    let due = await listDueTenantWorkIndex(d1, 'webhook_retry', 2000);
    expect(due).toHaveLength(1);

    await markTenantWorkIndexRan(d1, {
      workspaceId: 'ws_1',
      kind: 'webhook_retry',
      nextDueAt: null,
      now: 2000,
    });

    due = await listDueTenantWorkIndex(d1, 'webhook_retry', 5000);
    expect(due).toHaveLength(0);
    expect(d1.rows.get('ws_1:webhook_retry')?.enabled).toBe(0);
  });

  it('keeps a row due when nextDueAt is rescheduled', async () => {
    const d1 = memoryD1();
    await upsertTenantWorkIndex(d1, {
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      kind: 'workflow_poll',
      nextDueAt: 1000,
      now: 1000,
    });

    await markTenantWorkIndexRan(d1, {
      workspaceId: 'ws_1',
      kind: 'workflow_poll',
      nextDueAt: 10_000,
      now: 2000,
    });

    expect(await listDueTenantWorkIndex(d1, 'workflow_poll', 5000)).toHaveLength(0);
    expect(await listDueTenantWorkIndex(d1, 'workflow_poll', 10_000)).toHaveLength(1);
  });
});
