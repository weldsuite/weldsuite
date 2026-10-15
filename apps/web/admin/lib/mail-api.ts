import 'server-only';

import type { AdminIdentity } from './auth';
import { isOutboundInspect, isPlatformStatus, type OutboundInspect, type PlatformStatus } from './outbound-mail';

export type { OutboundInspect };

/**
 * Server-only client for mail-api's internal outbound-guard endpoints
 * (`/internal/outbound/*`), modelled on `billing-worker.ts`. The counters live
 * in mail-api's `OutboundLedger` Durable Objects, so the live view (usage, risk,
 * shadow-mode denials, the platform breaker) and the "reload the policy now" and
 * "review this workspace" calls go through it. This console holds the shared
 * OUTBOUND_ADMIN_SECRET and passes the signed-in admin along.
 *
 * Everything else on the Outbound mail screens reads the master DB, so they
 * still work, without the live view, when this is not configured.
 */

export type MailApiResult<T> = { ok: true; data: T } | { ok: false; code: string; error: string };

/** What a screen gets for a live panel; never throws. */
export type LiveState<T> = { kind: 'ok'; data: T } | { kind: 'not_configured' } | { kind: 'error'; message: string };

/** Page loads wait less than actions: the screen still renders from the DB without the live view. */
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 15_000;

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

function config(): { baseUrl: string; secret: string } | null {
  const baseUrl = withoutTrailingSlashes(process.env.MAIL_API_URL?.trim() ?? '');
  const secret = process.env.OUTBOUND_ADMIN_SECRET?.trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export function isMailApiConfigured(): boolean {
  return config() !== null;
}

async function callMailApi<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { identity: AdminIdentity; body?: unknown },
): Promise<MailApiResult<T>> {
  const cfg = config();
  if (!cfg) return { ok: false, code: 'NOT_CONFIGURED', error: 'mail-api is not configured for this console.' };

  const headers: Record<string, string> = {
    'x-admin-secret': cfg.secret,
    'x-admin-email': options.identity.email,
    'x-admin-user-id': options.identity.userId,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/internal/outbound${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'UNREACHABLE',
      error: err instanceof Error ? err.message : 'mail-api could not be reached.',
    };
  }

  const payload = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (res.ok && payload && 'data' in payload) return { ok: true, data: payload.data as T };
  return {
    ok: false,
    code: payload?.error?.code ?? `HTTP_${res.status}`,
    error: payload?.error?.message ?? `mail-api answered ${res.status}.`,
  };
}

function toLive<T>(result: MailApiResult<unknown>, check: (data: unknown) => data is T): LiveState<T> {
  if (result.ok) {
    return check(result.data) ? { kind: 'ok', data: result.data } : { kind: 'error', message: 'mail-api sent an answer this console does not understand.' };
  }
  if (result.code === 'NOT_CONFIGURED') return { kind: 'not_configured' };
  return { kind: 'error', message: result.error };
}

/** Live usage, risk and shadow-mode denials for one workspace (master id). */
export async function loadOutboundInspect(identity: AdminIdentity, workspaceId: string): Promise<LiveState<OutboundInspect>> {
  const result = await callMailApi<unknown>('GET', `/inspect?workspaceId=${encodeURIComponent(workspaceId)}`, { identity });
  return toLive(result, isOutboundInspect);
}

/** The platform breaker: whether first-contact mail is stopped platform-wide, and today's count against the quota. */
export async function loadPlatformStatus(identity: AdminIdentity): Promise<LiveState<PlatformStatus>> {
  const result = await callMailApi<unknown>('GET', '/platform', { identity });
  return toLive(result, isPlatformStatus);
}

/** Make the workspace's ledger reload its policy now instead of within the minute. */
export async function refreshOutboundLedger(
  identity: AdminIdentity,
  workspaceId: string,
): Promise<MailApiResult<{ ok: true }>> {
  return callMailApi<{ ok: true }>('POST', '/refresh', { identity, body: { workspaceId } });
}

/** Queue an AI review of the workspace's biggest template today; `queued` is false when there is none. */
export async function queueOutboundReview(
  identity: AdminIdentity,
  workspaceId: string,
): Promise<MailApiResult<{ queued: boolean }>> {
  const result = await callMailApi<{ queued?: unknown }>('POST', '/review', { identity, body: { workspaceId } });
  if (!result.ok) return result;
  return { ok: true, data: { queued: result.data?.queued === true } };
}
