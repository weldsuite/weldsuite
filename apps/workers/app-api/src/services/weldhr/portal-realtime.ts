/**
 * Live updates for the workforce portal.
 *
 * Portal users are not workspace members, so they don't listen on the
 * workspace hub (the entity-event bus that keeps the back office live). They
 * connect to their own `hrportal:<orgId>` hub instead, and every WeldHR
 * mutation also drops a signal there:
 *
 *   hrportal.employee.<employeeId>   the employee's own portal refreshes
 *   hrportal.client.<companyId>      every client account the employee works on
 *   hrportal.workspace               branding, settings, leave types
 *
 * Signals carry `{ entity, id }` and nothing else — the portal refetches
 * through its permission-checked API, so what a client sees is still decided
 * by client-view.ts, never by the socket.
 */

import type { Context } from 'hono';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  hrPortalHubKey,
  hrPortalTicketKvKey,
  hrPortalTopics,
  type HrPortalRealtimeTicket,
} from '@weldsuite/realtime/topics';
import { schema, type Database } from '../../db';
import { randomToken, sha256Hex } from '../../lib/commerce-portal-tokens';
import type { Env, Variables } from '../../types';
import { todayIso } from './shared';

type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Entities a client account can see some projection of (see client-view.ts). */
const CLIENT_VISIBLE = new Set([
  'hr_employee',
  'hr_client_assignment',
  'hr_attendance',
  'hr_coaching_log',
  'hr_evaluation',
  'hr_kpi_value',
  'hr_milestone',
]);

/** Short on purpose: the ticket is used within a second of being minted, and is single-use. */
const TICKET_TTL_SECONDS = 120;

export interface PortalSignal {
  /** Entity-event type, e.g. `hr_leave_request`. */
  entity: string;
  action: string;
  id: string;
  employeeId?: string | null;
  /** A company the change concerns even if the employee no longer works on it (e.g. an ended assignment). */
  companyId?: string | null;
  /** Workspace-wide change every portal user should pick up (branding, leave types). */
  workspaceWide?: boolean;
  /**
   * Whether the employee may know about this record at all. False for
   * internal coaching logs and draft evaluations — even an id-only signal
   * would tell them something exists. Defaults to true.
   */
  portal?: boolean;
  /**
   * Whether the change touches what a client account sees. Defaults to the
   * entity being client-visible at all; callers narrow it to "shared with
   * the client, before or after this change".
   */
  client?: boolean;
}

async function activeCompanyIds(db: Database, employeeId: string): Promise<string[]> {
  const a = schema.hrClientAssignments;
  const today = todayIso();
  const rows = await db
    .selectDistinct({ companyId: a.companyId })
    .from(a)
    .where(and(eq(a.employeeId, employeeId), lte(a.startDate, today), or(isNull(a.endDate), gte(a.endDate, today))));
  return rows.map((r) => r.companyId);
}

async function publishSignal(c: HrContext, signal: PortalSignal): Promise<void> {
  const binding = c.env.REALTIME;
  const orgId = c.get('workspaceId');
  if (!binding || !orgId) return;

  const toEmployee = signal.portal !== false;
  const toClient = toEmployee && (signal.client ?? CLIENT_VISIBLE.has(signal.entity));

  const topics = new Set<string>();
  if (signal.workspaceWide) topics.add(hrPortalTopics.workspace);
  if (signal.employeeId && toEmployee) {
    topics.add(hrPortalTopics.employee(signal.employeeId));
    if (toClient) {
      for (const companyId of await activeCompanyIds(c.get('tenantDb'), signal.employeeId)) {
        topics.add(hrPortalTopics.client(companyId));
      }
    }
  }
  if (signal.companyId && toClient) topics.add(hrPortalTopics.client(signal.companyId));
  if (topics.size === 0) return;

  const publisher = new RealtimePublisher(binding);
  const hub = hrPortalHubKey(orgId);
  const data = { entity: signal.entity, id: signal.id };
  const actor = c.get('userId') || 'system';
  await Promise.all([...topics].map((topic) => publisher.publish(hub, topic, signal.action, data, actor)));
}

/** Fire-and-forget: never delays or fails the mutation that caused it. */
export function notifyPortal(c: HrContext, signal: PortalSignal): void {
  c.executionCtx.waitUntil(
    publishSignal(c, signal).catch((err) => {
      console.warn('[weldhr] portal realtime signal failed:', err);
    }),
  );
}

// ---------------------------------------------------------------------------
// Connect tickets
// ---------------------------------------------------------------------------

/** Public WebSocket endpoint of the realtime worker for portal connections. */
export function hrPortalRealtimeUrl(env: Env): string {
  if (env.REALTIME_PUBLIC_URL) return `${env.REALTIME_PUBLIC_URL.replace(/\/$/, '')}/ws/hr-portal`;
  if (env.ENVIRONMENT === 'production') return 'wss://realtime.weldsuite.org/ws/hr-portal';
  if (env.ENVIRONMENT === 'test') return 'wss://realtime-test.weldsuite.org/ws/hr-portal';
  return 'ws://localhost:8790/ws/hr-portal';
}

/**
 * Mint a single-use ticket for the signed-in portal principal. Returns null
 * when KV is unavailable (local runs without bindings) — the portal then just
 * works without live updates.
 */
export async function mintPortalRealtimeTicket(
  env: Env,
  ticket: HrPortalRealtimeTicket,
): Promise<{ ticket: string; url: string; expiresIn: number } | null> {
  if (!env.WORKSPACE_CACHE?.put) return null;
  const raw = randomToken();
  await env.WORKSPACE_CACHE.put(hrPortalTicketKvKey(await sha256Hex(raw)), JSON.stringify(ticket), {
    expirationTtl: TICKET_TTL_SECONDS,
  });
  return { ticket: raw, url: hrPortalRealtimeUrl(env), expiresIn: TICKET_TTL_SECONDS };
}
