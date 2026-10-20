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
 * docs/plans/weldmail-outbound-abuse.md), after checking that the From address
 * is one of the workspace's own mailboxes. The transactional send carries
 * WeldSuite's own mail and stays outside the guard, so its From is pinned to
 * WeldSuite's own sender domains instead.
 *
 * NOTE: the Resend call below is a deliberate minimal inline of
 * `@weldsuite/transactional-email`'s `sendEmail` (packages/core/transactional-email/
 * src/resend.ts) — app-api does not (yet) depend on that package directly.
 * If the dependency is ever added, this can be swapped for the package import.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { sendEmail as sendViaCloudflare } from '@weldsuite/worker-email';
import { OutboundDeniedError, bareAddress, guardedSend } from '@weldsuite/mail-domain/outbound';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

/**
 * Headers a caller may set. Everything else (From, To, Bcc, Return-Path,
 * Received, DKIM-Signature, Content-*, ...) is either owned by the transport or
 * lets the caller forge routing or authentication, so it is rejected. Matched
 * case-insensitively; values must be a single line (no CR/LF).
 */
export const ALLOWED_EMAIL_HEADERS: readonly string[] = [
  'reply-to',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'in-reply-to',
  'references',
];

/** The only domains `/send-transactional-email` may send as: WeldSuite's own. */
export const SYSTEM_SENDER_DOMAINS: readonly string[] = ['mail.weldsuite.org', 'weldsuite.org'];

const BARE_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** True when `from` is a single address on one of WeldSuite's own sender domains. */
export function isSystemSender(from: string): boolean {
  const address = bareAddress(from);
  if (!BARE_ADDRESS.test(address)) return false;
  return SYSTEM_SENDER_DOMAINS.includes(address.slice(address.lastIndexOf('@') + 1));
}

/** `/send-transactional-email` was asked to send as an address outside WeldSuite's own domains. */
export class SystemSenderError extends Error {
  constructor() {
    super(`from must be an address on ${SYSTEM_SENDER_DOMAINS.join(' or ')}`);
    this.name = 'SystemSenderError';
  }
}

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
  /** Clerk org id (workflow-worker's `tenant.workspaceId`). Required: every send is guarded. */
  clerkOrgId: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * True when `from` is an active mailbox of the workspace behind `db`. The
 * outbound guard only refuses an address another workspace has registered; an
 * address nobody claims (say `ceo@weldsuite.org`) would pass it, so a workflow
 * email must additionally be sent from one of the workspace's own mailboxes.
 */
async function isWorkspaceMailbox(db: Database, from: string): Promise<boolean> {
  const address = bareAddress(from);
  const rows = await db
    .select({ id: schema.mailAccounts.id })
    .from(schema.mailAccounts)
    .where(
      and(
        sql`lower(${schema.mailAccounts.email}) = ${address}`,
        eq(schema.mailAccounts.status, 'active'),
        isNull(schema.mailAccounts.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Send a WeldConnect `send_email` step's email: `sendInternalEmail` behind the
 * outbound mail guard, as a new conversation (`source: 'workflow'`). The From
 * address must be an active mailbox of the workspace. Throws
 * `OutboundDeniedError` when it is not or the guard refuses; the route turns
 * that into a 403/422/429 with the denial's code. A tenant DB that cannot be
 * resolved fails the send (500) rather than skipping the sender check.
 */
export async function sendWorkflowEmail(
  env: Env,
  params: InternalEmailParams,
  workspace: WorkflowEmailWorkspace,
): Promise<InternalEmailResult> {
  // No request-scoped tenant DB on this route (service-to-service, no Clerk).
  const db = await getTenantDbForWorkspace(env, workspace.clerkOrgId);

  if (!(await isWorkspaceMailbox(db, params.from))) {
    throw new OutboundDeniedError({ code: 'SENDER_NOT_OWNED', reason: 'sender_not_workspace_mailbox' });
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
 * mirroring the legacy api-worker behavior exactly. Unguarded by design (it is
 * WeldSuite's own mail), so `from` must be on `SYSTEM_SENDER_DOMAINS`: it can
 * never send as a tenant's domain. Throws `SystemSenderError` otherwise.
 */
export async function sendInternalTransactionalEmail(
  env: Env,
  params: InternalEmailParams,
): Promise<InternalEmailResult> {
  if (!isSystemSender(params.from)) {
    throw new SystemSenderError();
  }

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
