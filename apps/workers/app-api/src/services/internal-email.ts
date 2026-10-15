/**
 * Internal email sending — successor to the legacy api-worker
 * `POST /api/internal/send-email` + `/send-transactional-email` surface
 * (apps/api-worker/src/routes/internal/index.ts; W3 of the legacy-worker
 * phase-out plan).
 *
 * Pure functions, no Hono context. Reuses app-api's existing outbound mail
 * path (`lib/cloudflare-email.ts` → Cloudflare `[[send_email]]` binding) for
 * regular sends, and Resend for transactional sends (falling back to the
 * Cloudflare path when RESEND_API_KEY is not configured — same fallback the
 * legacy endpoint had).
 *
 * `sendWorkflowEmail` is the one guarded send: a WeldConnect `send_email` step
 * writes user-composed mail to arbitrary recipients, so it goes through the
 * outbound mail guard (`@weldsuite/mail-domain/outbound`,
 * docs/plans/weldmail-outbound-abuse.md). The other functions here carry
 * WeldSuite's own mail and stay outside it.
 *
 * NOTE: the Resend call below is a deliberate minimal inline of
 * `@weldsuite/transactional-email`'s `sendEmail` (packages/core/transactional-email/
 * src/resend.ts) — app-api does not (yet) depend on that package directly.
 * If the dependency is ever added, this can be swapped for the package import.
 */

import { sendEmail as sendViaCloudflare } from '@weldsuite/worker-email';
import { guardedSend } from '@weldsuite/mail-domain/outbound';
import { getTenantDbForWorkspace, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

export interface InternalEmailParams {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
}

export interface InternalEmailResult {
  messageId: string;
}

/**
 * Send an email through app-api's standard outbound path (Cloudflare
 * `send_email` binding). Legacy contract: the api-worker endpoint sent via
 * Stalwart JMAP; the payload + result shape are identical, only the
 * transport changed.
 */
export async function sendInternalEmail(
  env: Env,
  params: InternalEmailParams,
): Promise<InternalEmailResult> {
  const result = await sendViaCloudflare(env, {
    from: params.from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    cc: params.cc,
    bcc: params.bcc,
    headers: params.headers,
  });
  return { messageId: result.messageId };
}

/** The workspace a workflow email is sent for, and where the guard may count it after the response. */
export interface WorkflowEmailWorkspace {
  /**
   * Clerk org id (workflow-worker's `tenant.workspaceId`). Absent only while
   * an older workflow-worker is still deployed: the send then skips the guard.
   */
  clerkOrgId?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Send a WeldConnect `send_email` step's email: `sendInternalEmail` behind the
 * outbound mail guard, as a new conversation (`source: 'workflow'`). Throws
 * `OutboundDeniedError` when the guard refuses; the route turns that into a
 * 403/422/429 with the denial's code.
 */
export async function sendWorkflowEmail(
  env: Env,
  params: InternalEmailParams,
  workspace: WorkflowEmailWorkspace,
): Promise<InternalEmailResult> {
  if (!workspace.clerkOrgId) {
    console.warn('[Internal] send-email without a workspaceId: outbound guard skipped');
    return sendInternalEmail(env, params);
  }

  // No request-scoped tenant DB on this route (service-to-service, no Clerk).
  // Without it the guard still checks ownership and the ledger, only the
  // complaint-suppression and first-contact lookups are skipped.
  let db: Database | null = null;
  try {
    db = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
  } catch (err) {
    console.warn('[Internal] tenant DB lookup failed for the outbound guard:', err instanceof Error ? err.message : err);
  }

  return guardedSend(
    env,
    db,
    {
      subject: { kind: 'workspace', clerkOrgId: workspace.clerkOrgId },
      source: 'workflow',
      kind: 'new_thread',
      from: params.from,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subjectLine: params.subject,
      text: params.text,
      html: params.html,
    },
    () => sendInternalEmail(env, params),
    { waitUntil: workspace.waitUntil },
  );
}

/**
 * Send a transactional email via Resend (from @mail.weldsuite.org senders).
 * Falls back to the Cloudflare send path when RESEND_API_KEY is unset —
 * mirroring the legacy api-worker behavior exactly.
 */
export async function sendInternalTransactionalEmail(
  env: Env,
  params: InternalEmailParams,
): Promise<InternalEmailResult> {
  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: params.from,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        cc: params.cc,
        bcc: params.bcc,
        headers: params.headers,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { id: string };
    return { messageId: json.id };
  }

  // Fallback to the Cloudflare send path.
  return sendInternalEmail(env, params);
}
