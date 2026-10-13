/**
 * Staff alerts for the outbound guard (docs/plans/weldmail-outbound-abuse.md).
 *
 * The ledgers record cases in master `outbound_mail_cases`; this sweep, on the
 * existing 5-minute cron, emails each new one to ABUSE_NOTIFY_EMAIL and stamps
 * `alertedAt`. Master DB only — no tenant database is opened. Cases older than
 * a day that never got out (no address configured, mail down) are left alone.
 */

import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import { sendSystemEmail } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { OutboundCaseVerdict } from '@weldsuite/db/schema/master';
import type { Env } from '../types';

const BATCH = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ADMIN_CONSOLE_URL = 'https://admin.weldsuite.org';

function verdictLabel(verdict: OutboundCaseVerdict | null): string | null {
  return verdict ? `${verdict.category} (${verdict.confidence.toFixed(2)})` : null;
}

function metric<T extends 'string' | 'number'>(
  metrics: Record<string, unknown>,
  key: string,
  type: T,
): (T extends 'string' ? string : number) | null {
  const value = metrics[key];
  return typeof value === type ? (value as T extends 'string' ? string : number) : null;
}

/** Email every un-alerted case from the last day. Returns how many went out. Never throws. */
export async function sendPendingOutboundAlerts(env: Env): Promise<number> {
  const to = env.ABUSE_NOTIFY_EMAIL?.trim();
  if (!to) return 0;
  const transport = workerTransport(env);
  if (!transport) return 0;

  const { outboundMailCases, workspaces } = masterSchema;
  const db = getMasterDb(env);
  let sent = 0;
  try {
    const pending = await db
      .select({ row: outboundMailCases, workspaceName: workspaces.name })
      .from(outboundMailCases)
      .leftJoin(workspaces, eq(workspaces.id, outboundMailCases.workspaceId))
      .where(and(isNull(outboundMailCases.alertedAt), gte(outboundMailCases.createdAt, new Date(Date.now() - MAX_AGE_MS))))
      .orderBy(asc(outboundMailCases.createdAt))
      .limit(BATCH);

    const origin = (env.ADMIN_CONSOLE_URL?.trim() || DEFAULT_ADMIN_CONSOLE_URL).replace(/\/+$/, '');
    for (const { row, workspaceName } of pending) {
      const metrics = row.metrics as Record<string, unknown>;
      try {
        await sendSystemEmail(transport, {
          template: 'internal.outbound-abuse-alert',
          props: {
            trigger: row.trigger,
            severity: row.severity,
            summary: metric(metrics, 'summary', 'string') ?? row.trigger,
            workspaceName: workspaceName ?? (row.personalAccountId ? `Personal account ${row.personalAccountId}` : null),
            workspaceId: row.workspaceId,
            riskScore: row.riskScore,
            state: metric(metrics, 'state', 'string'),
            verdict: verdictLabel(row.aiVerdict),
            templateSubject: row.subject,
            // No snippet: customer mail text is only read through the console's
            // audited "Show snippet"; the link below goes there.
            snippet: null,
            firstContactRecipients: metric(metrics, 'firstContactRecipients', 'number'),
            sources: row.sources ?? [],
            domains: row.sampleDomains ?? [],
            reviewUrl: `${origin}/outbound-mail?case=${encodeURIComponent(row.id)}`,
          },
          to,
          locale: 'en',
        });
        await db.update(outboundMailCases).set({ alertedAt: new Date() }).where(eq(outboundMailCases.id, row.id));
        sent += 1;
      } catch (err) {
        console.error('[outbound-alerts] alert failed for case', row.id, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error('[outbound-alerts] sweep failed:', err instanceof Error ? err.message : err);
  }
  return sent;
}
