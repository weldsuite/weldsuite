/**
 * Shared helpers for the action handlers.
 */

import { NonRetryableStepError } from '../errors';
import type { ActionContext, WorkflowEnv } from '../types';

/**
 * Service bindings to a worker's internal entrypoint, trusted by topology (a
 * named entrypoint is reachable only over a binding, so no secret is sent):
 *  - `APP_API_INTERNAL` → app-api `AppApiInternal` (send-email)
 *  - `CONNECT_INTERNAL` → connect-api `ConnectInternal` (workflow-actions)
 */
export type InternalBinding = 'APP_API_INTERNAL' | 'CONNECT_INTERNAL';

/** A named entrypoint that is not exported (yet) fails the call before any handler runs. */
function isMissingEntrypoint(err: unknown): boolean {
  return err instanceof Error && /entrypoint/i.test(err.message);
}

/**
 * POST to an `/api/internal/*` route. Preferred path: the named-entrypoint
 * binding `via` (no secret). Fallback while the binding is absent or the
 * entrypoint is not deployed yet: public HTTP to app-api (`APP_API_URL`, which
 * forwards module paths to their worker) with the shared INTERNAL_API_SECRET
 * bearer; this worker's secret must match the target's for that path
 * (apps/workers/app-api/src/routes/internal/index.ts). Only a missing entrypoint
 * falls back, so a step is never sent twice. Throws with the response body on a
 * non-2xx so the step fails with a useful message.
 */
export async function postInternalApi<T>(
  env: WorkflowEnv,
  path: string,
  body: unknown,
  label: string,
  via: InternalBinding,
): Promise<T> {
  const serialized = JSON.stringify(body);
  let response: Response | undefined;

  const binding = env[via] as Fetcher | undefined;
  if (binding) {
    try {
      response = await binding.fetch(`https://internal/api/internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
      });
    } catch (err) {
      if (!isMissingEntrypoint(err)) throw err;
      console.warn(`[InternalApi] ${via} entrypoint unavailable for ${label}, falling back to HTTP:`, err);
    }
  }

  if (!response) {
    const appApiUrl = env.APP_API_URL
      ? String(env.APP_API_URL).replace(/\/+$/, '')
      : 'https://app-api.weldsuite.org';
    const internalSecret = env.INTERNAL_API_SECRET;
    if (!internalSecret) throw new Error(`INTERNAL_API_SECRET not configured for ${label}`);

    response = await fetch(`${appApiUrl}/api/internal${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${internalSecret}`, 'Content-Type': 'application/json' },
      body: serialized,
    });
  }

  if (!response.ok) {
    throw internalApiFailure(label, response.status, await response.text());
  }
  return (await response.json()) as T;
}

/** Loose address check: one `@`, no whitespace or list separators, a dot in the domain. */
export const EMAIL_ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** A rejection that repeating the same request cannot fix: a client error or a validation failure. */
function isPermanentRejection(status: number, body: string): boolean {
  if (status === 408 || status === 429) return false;
  if (status >= 400 && status < 500) return true;
  // The mail route wraps provider validation failures in a 500.
  return /E_VALIDATION_ERROR|VALIDATION_ERROR/.test(body);
}

/** Pull the human part out of an `/api/internal` error body (`{ success: false, error: "..." }`). */
function readableErrorMessage(body: string): string | null {
  let text: string | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const raw = parsed.error ?? parsed.message;
    if (typeof raw === 'string') text = raw;
    else if (raw && typeof raw === 'object' && typeof (raw as { message?: unknown }).message === 'string') {
      text = (raw as { message: string }).message;
    } else if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
      // A zod validation rejection (`{ success: false, error: { issues: [...] } }`).
      const issues = (raw as { issues: Array<{ path?: unknown[]; message?: string }> }).issues;
      text = issues
        .map((i) => `${i.path?.length ? `${i.path.join('.')}: ` : ''}${i.message ?? 'invalid'}`)
        .join('; ');
    }
  } catch {
    return null;
  }
  if (!text) return null;
  return text
    .replace(/^\w+ failed for [^:]*:\s*/, '') // "send_email failed for a@b: ..."
    .replace(/^Error \([A-Z_]+\)\s*/, '') // "Error (E_VALIDATION_ERROR) ..."
    .trim();
}

/**
 * The error a failed `/api/internal` call becomes: a readable message, the raw
 * response kept in `details`, and a `NonRetryableStepError` when the rejection
 * is permanent so neither the engine nor Cloudflare retries it.
 */
export function internalApiFailure(label: string, status: number, body: string): Error {
  const readable = readableErrorMessage(body);
  const message = readable ? `${label} failed: ${readable}` : `${label} failed: ${status} - ${body.slice(0, 500)}`;
  const details = { status, body: body.slice(0, 2000) };
  if (isPermanentRejection(status, body)) return new NonRetryableStepError(message, details);
  const err = new Error(message) as Error & { details?: unknown };
  err.details = details;
  return err;
}

/** Resolve the target conversation id from inputs or the triggering event. */
export function resolveConversationId(
  inputs: Record<string, unknown>,
  context: ActionContext,
): string | null {
  if (inputs.conversationId) return String(inputs.conversationId);
  const td = context.triggerData as Record<string, unknown> | undefined;
  if (td?.entityType === 'helpdesk_conversation') return String(td.entityId);
  if (td?.data && typeof td.data === 'object' && 'conversationId' in (td.data as object)) {
    return String((td.data as Record<string, unknown>).conversationId);
  }
  return null;
}

/** Best-effort realtime publish (no-op when REALTIME isn't bound). */
export async function publishRealtime(
  env: WorkflowEnv,
  workspaceId: string,
  channel: string,
  event: string,
  data: unknown,
): Promise<void> {
  if (!env.REALTIME) return;
  try {
    const { RealtimePublisher } = await import('@weldsuite/realtime/server');
    const rt = new RealtimePublisher(env.REALTIME);
    if (channel.startsWith('conversation:')) {
      const convId = channel.split(':')[1];
      await rt.conversationPublish(convId, {
        type: event,
        ...(data && typeof data === 'object' ? data : { data }),
        ts: Date.now(),
      });
    } else {
      await rt.publish(workspaceId, channel.replace(`workspace:${workspaceId}`, 'helpdesk'), event, data, 'system');
    }
  } catch (err) {
    console.warn(`[Realtime] Failed to publish ${event}: ${err}`);
  }
}
