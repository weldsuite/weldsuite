import { describe, expect, it, vi } from 'vitest';
import type { CrmSyncIndexRow } from '@weldsuite/connectors';
import { runCrmDueSweep } from './crm-due';

function row(overrides: Partial<CrmSyncIndexRow> = {}): CrmSyncIndexRow {
  return {
    connection_id: 'intc_1',
    workspace_id: 'ws_1',
    clerk_org_id: 'org_1',
    provider: 'attio',
    enabled: 1,
    next_due_at: 0,
    interval_minutes: 360,
    renew_watch_at: null,
    last_triggered_at: null,
    last_error: null,
    updated_at: 0,
    ...overrides,
  };
}

describe('runCrmDueSweep', () => {
  it('triggers APP_API sync for due rows and advances schedule', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response('{}', { status: 200 });
    });
    const mark = vi.fn(async () => undefined);
    const d1 = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          async all() {
            if (sql.includes('SELECT')) return { results: [row()] };
            return { results: [] };
          },
          async run() {
            if (sql.includes('UPDATE')) await mark();
            return {};
          },
        }),
      }),
    };

    const result = await runCrmDueSweep(d1 as never, {
      APP_API: { fetch: fetchImpl } as never,
      INTERNAL_API_SECRET: 'secret',
    });

    expect(result.triggered).toBe(1);
    expect(urls.some((url) => url.includes('/sync'))).toBe(true);
    expect(mark).toHaveBeenCalled();
  });
});
