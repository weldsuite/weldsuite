/**
 * CRM due sweep — D1 due rows only, then APP_API sync (opens one tenant).
 */

import {
  listDueCrmSyncIndex,
  markCrmSyncIndexTriggered,
  type CrmSyncIndexDb,
  type CrmSyncIndexRow,
} from '@weldsuite/connectors';

export interface CrmDueEnv {
  APP_API: Fetcher;
  INTERNAL_API_SECRET?: string;
}

export async function runCrmDueSweep(
  d1: CrmSyncIndexDb,
  env: CrmDueEnv,
  now = Date.now(),
): Promise<{ triggered: number; renewed: number; failed: number }> {
  const rows = await listDueCrmSyncIndex(d1, now);
  let triggered = 0;
  let renewed = 0;
  let failed = 0;

  for (const row of rows) {
    const outcome = await processCrmDueRow(row, env, now);
    if (outcome === 'triggered') triggered += 1;
    else if (outcome === 'renewed') renewed += 1;
    else failed += 1;

    await markCrmSyncIndexTriggered(d1, {
      connectionId: row.connection_id,
      intervalMinutes: row.interval_minutes,
      error: outcome === 'failed' ? 'sync or renew failed' : null,
      now,
    });
  }

  return { triggered, renewed, failed };
}

async function processCrmDueRow(
  row: CrmSyncIndexRow,
  env: CrmDueEnv,
  now: number,
): Promise<'triggered' | 'renewed' | 'failed'> {
  let renewed = false;
  if (
    row.provider === 'google_calendar' &&
    row.renew_watch_at != null &&
    row.renew_watch_at <= now
  ) {
    try {
      const renewResponse = await env.APP_API.fetch(
        `https://internal/api/integrations/connections/${row.connection_id}/renew-watch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workspace-Id': row.clerk_org_id,
            'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
          },
        },
      );
      if (renewResponse.ok) renewed = true;
      else {
        console.error(
          `[CrmDue] Watch renewal failed for ${row.connection_id}: ${renewResponse.status}`,
        );
      }
    } catch (err) {
      console.error(`[CrmDue] Watch renewal error for ${row.connection_id}:`, err);
    }
  }

  try {
    const response = await env.APP_API.fetch(
      `https://internal/api/integrations/connections/${row.connection_id}/sync`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': row.clerk_org_id,
          'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
        },
      },
    );
    if (!response.ok) {
      console.error(`[CrmDue] Sync failed for ${row.connection_id}: ${response.status}`);
      return renewed ? 'renewed' : 'failed';
    }
    return renewed ? 'renewed' : 'triggered';
  } catch (err) {
    console.error(`[CrmDue] Sync error for ${row.connection_id}:`, err);
    return renewed ? 'renewed' : 'failed';
  }
}
