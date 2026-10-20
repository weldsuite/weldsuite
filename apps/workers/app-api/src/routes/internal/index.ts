/**
 * Internal service-to-service routes — successor to the legacy api-worker
 * `/api/internal/*` surface (apps/api-worker/src/routes/internal/index.ts;
 * W3 of the legacy-worker phase-out plan).
 *
 * Caller: workflow-worker's send_email action
 * (apps/workers/workflow-worker/src/engine/actions/communication.ts), over its
 * `APP_API_INTERNAL` binding to the `AppApiInternal` entrypoint (no secret).
 * /send-transactional-email has no caller in the repo.
 *
 * The PUBLIC mount (registered BEFORE the global /api/* Clerk guard in
 * src/index.ts) stays only as workflow-worker's fallback while the entrypoint
 * is not deployed (it falls back to HTTP when the binding is missing); it
 * authenticates in-route via a shared-secret bearer, compared in constant time:
 * `Authorization: Bearer <INTERNAL_API_SECRET>`. The caller's
 * INTERNAL_API_SECRET must match this worker's (ops contract). That secret is
 * the only thing between the open internet and these routes, so neither route
 * trusts its payload: /send-email sends only from a mailbox of the workspace
 * behind the outbound guard, /send-transactional-email only from WeldSuite's
 * own domains, and both accept only an allowlist of extra headers.
 *
 * Deliberately NOT ported from the legacy surface: the workspace-database
 * delete endpoint and the AI endpoints (both dead — zero callers).
 *
 * Response shapes intentionally preserve the LEGACY contract
 * ({ success, messageId } / { success:false, error }) rather than the app-api
 * { data }/{ error } envelope — workflow-worker (and previously Trigger.dev
 * tasks) parse `result.messageId` off the top level. This is a machine
 * contract, not a platform-consumed route.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { OutboundDeniedError } from '@weldsuite/mail-domain/outbound';
import { timingSafeEqualStr } from '@weldsuite/worker-kit/webhook-token';
import type { Env, Variables } from '../../types';
import {
  ALLOWED_EMAIL_HEADERS,
  SYSTEM_SENDER_DOMAINS,
  SystemSenderError,
  sendInternalTransactionalEmail,
  sendWorkflowEmail,
} from '../../services/internal-email';

export const internalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Auth — requests through the `AppApiInternal` entrypoint (service binding
// only) are trusted by topology; the public mount keeps the shared
// INTERNAL_API_SECRET bearer on every route until workflow-worker uses the
// entrypoint. (The legacy api-worker m2mAuth also accepted Clerk M2M tokens;
// that fallback had no remaining callers and is intentionally dropped here.)
// ---------------------------------------------------------------------------

internalRoutes.use('*', async (c, next) => {
  if (c.get('internalTrusted') === true) {
    await next();
    return;
  }

  const secret = c.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[Internal API] INTERNAL_API_SECRET is not configured');
    return c.json({ error: 'Internal auth not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  if (!timingSafeEqualStr(authHeader.slice(7), secret)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

// ---------------------------------------------------------------------------
// POST /send-email — regular outbound email (workflow send_email action).
// Payload contract identical to the legacy api-worker endpoint, plus the
// workspace the step runs in. The email goes through the outbound mail guard;
// a refusal answers with the guard's status and the app-api error envelope
// ({ error: { code, message, details } }) so the caller can stop its loop.
// ---------------------------------------------------------------------------

/** One line: a CR/LF in an address, subject or header value would inject headers. */
const noLineBreaks = (value: string) => !/[\r\n]/.test(value);
const singleLine = z.string().refine(noLineBreaks, 'must not contain line breaks');
const requiredLine = z.string().min(1).refine(noLineBreaks, 'must not contain line breaks');

/**
 * Extra headers: only `ALLOWED_EMAIL_HEADERS`, single-line values. An unknown
 * header is a 400, not silently dropped, so a caller notices.
 */
const emailHeadersSchema = z
  .record(z.string().max(998).refine(noLineBreaks, 'must not contain line breaks'))
  .refine(
    (headers) => Object.keys(headers).every((name) => ALLOWED_EMAIL_HEADERS.includes(name.toLowerCase())),
    { message: `headers: only ${ALLOWED_EMAIL_HEADERS.join(', ')} may be set` },
  );

const internalSendEmailSchema = z.object({
  from: requiredLine,
  to: z.array(singleLine).min(1),
  subject: requiredLine,
  html: z.string().optional(),
  text: z.string().optional(),
  cc: z.array(singleLine).optional(),
  bcc: z.array(singleLine).optional(),
  headers: emailHeadersSchema.optional(),
  // Clerk org id of the workspace the workflow runs in (workflow-worker's
  // `tenant.workspaceId`). Required: the send must come from one of its
  // mailboxes and the outbound guard counts it against it.
  workspaceId: z.string().min(1),
});

internalRoutes.post('/send-email', zValidator('json', internalSendEmailSchema), async (c) => {
  const data = c.req.valid('json');

  try {
    const result = await sendWorkflowEmail(
      c.env,
      {
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text,
        cc: data.cc,
        bcc: data.bcc,
        headers: data.headers,
      },
      { clerkOrgId: data.workspaceId, waitUntil: (promise) => c.executionCtx.waitUntil(promise) },
    );

    return c.json({ success: true, messageId: result.messageId });
  } catch (err) {
    if (err instanceof OutboundDeniedError) {
      console.warn(`[Internal] Send email blocked by the outbound guard (${err.code})`);
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    console.error('[Internal] Send email failed:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /send-transactional-email — Resend (from @mail.weldsuite.org), with
// fallback to the regular send path when RESEND_API_KEY is unset. WeldSuite's
// own mail: no guard, so `from` is limited to WeldSuite's sender domains and
// can never be a tenant's address. No caller in the repo today.
// ---------------------------------------------------------------------------

const internalTransactionalEmailSchema = z.object({
  from: requiredLine,
  to: z.array(singleLine).min(1),
  subject: requiredLine,
  html: z.string().optional(),
  text: z.string().optional(),
  cc: z.array(singleLine).optional(),
  bcc: z.array(singleLine).optional(),
  headers: emailHeadersSchema.optional(),
});

internalRoutes.post(
  '/send-transactional-email',
  zValidator('json', internalTransactionalEmailSchema),
  async (c) => {
    const data = c.req.valid('json');

    try {
      const result = await sendInternalTransactionalEmail(c.env, {
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text,
        cc: data.cc,
        bcc: data.bcc,
        headers: data.headers,
      });

      return c.json({ success: true, messageId: result.messageId });
    } catch (err) {
      if (err instanceof SystemSenderError) {
        return c.json(
          { error: { code: 'SENDER_NOT_ALLOWED', message: err.message, details: { allowedDomains: SYSTEM_SENDER_DOMAINS } } },
          403,
        );
      }
      console.error('[Internal] Send transactional email failed:', err);
      return c.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  },
);

// POST /workflow-actions/create-customer (workflow-worker's WeldConnect
// create_customer step) moved to connect-api with the connect module:
// @weldsuite/api-modules gives connect the /api/internal/workflow-actions
// prefix, so the kit's forwarder hands it over the CONNECT_API binding.

// POST /telephony/fulfill-number (billing-worker's paid phone-number
// fulfilment) moved to call-api with the call module: @weldsuite/api-modules
// gives call the /api/internal/telephony prefix, so the kit's forwarder hands
// it over the CALL_API binding.
