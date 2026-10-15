/**
 * WeldReach on the public API: everything the shared route files
 * (`routes/v1/reach/*`) need from this worker.
 *
 * The routes call the domain package (`@weldsuite/reach-domain/*`), which knows
 * nothing about bindings or Hono. This file is the per-worker seam that hands it
 * what it asks for, so the route files stay free of `c.env` and can be copied
 * byte-identical into mcp-server (which provides its own version of this file):
 *
 *   - `reachAccess`       the approval gate, the same decision as reach-api's `appAccessGate`
 *   - `reachDeps`         db + entity events + send-sweep wake-up + limits, for the write functions
 *   - `reachMailboxReads` the tenant DB and a lazy master handle, for the mailbox warmup numbers
 *   - `reachInboxStorage` the R2 bucket that holds the raw inbound replies
 *   - `reachReplyDeps`    the encryption keys, the access row and the kill switch, for a reply
 *   - `reachSendingEnabled`, `reachValidation`, `reachErrorHandler`, `withoutMailpool`
 *
 * Two ids are in play, as everywhere in this worker: the session's `workspaceId`
 * is the master `workspaces.id`, while the app access cache and the send sweep's
 * due index are keyed by the Clerk org id (`c.get('reach').clerkOrgId`).
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { ZodError } from 'zod';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { WELDREACH_APP_CODE, resolveWeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import { getFlags, type FlagsContext } from '@weldsuite/feature-flags/server';
import { appAccessRequiredBody, getAppAccessFrom } from '@weldsuite/worker-kit/app-access';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { ReplyStorage, SendReplyDeps } from '@weldsuite/reach-domain/inbox';
import type { MailboxReadDeps } from '@weldsuite/reach-domain/mailboxes';
import { ReachDomainError } from '@weldsuite/reach-domain/errors';
import type { ReachDuePort, ReachEventSink } from '@weldsuite/reach-domain/events';
import type { HonoEnv, ReachRequest } from '../types';
import { errorHandler } from '../middleware/error-handler';
import { error } from './response';
import { createMasterDb } from './master-db';
import { resolveClerkOrgId } from './social-context';

type ReachContext = Context<HonoEnv>;

/** Stands in for `WORKSPACE_CACHE` when the binding is missing: every read is a miss, so master answers. */
const NO_CACHE = { get: async () => null, put: async () => undefined } as unknown as Pick<KVNamespace, 'get' | 'put'>;

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

/**
 * Only workspaces whose WeldReach access staff approved get through; any other
 * status is 403 `APP_ACCESS_REQUIRED` with `{ appCode, status }`, whatever scopes
 * the key holds. The same decision as reach-api's `appAccessGate`, and the same
 * 60 s `appaccess:<clerkOrgId>:weldreach` entry in `WORKSPACE_CACHE`, so a
 * suspension reaches the public API as fast as it reaches the app. The master
 * DB (Hyperdrive) is opened only on a cache miss.
 *
 * Puts `{ clerkOrgId, access }` on the context for the limits and the billing
 * state the launch, enrol and reply checks use.
 */
export const reachAccess: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.get('apiSession');
  if (!session) return error.unauthorized(c);

  // The auth middleware carries the org id; an older cached session entry does not, and then it is looked up.
  const clerkOrgId = session.clerkOrgId !== undefined ? session.clerkOrgId : await resolveClerkOrgId(c.env, session.workspaceId);
  if (!clerkOrgId) return c.json(appAccessRequiredBody(WELDREACH_APP_CODE, 'none'), 403);

  const access = await getAppAccessFrom(
    { cache: c.env.WORKSPACE_CACHE ?? NO_CACHE, master: () => createMasterDb(c.env.HYPERDRIVE_MASTER) },
    clerkOrgId,
    WELDREACH_APP_CODE,
  );
  if (access.status !== 'approved') return c.json(appAccessRequiredBody(WELDREACH_APP_CODE, access.status), 403);

  c.set('reach', { clerkOrgId, access });
  await next();
};

/** What the gate resolved. Throws when a route runs without it: that is a wiring mistake, not a client error. */
export function reachRequest(c: ReachContext): ReachRequest {
  const request = c.get('reach');
  if (!request) throw new Error('reachAccess did not run before a WeldReach route');
  return request;
}

// ---------------------------------------------------------------------------
// Dependencies of the domain functions
// ---------------------------------------------------------------------------

/** Entity events of this request, published like every other write of the public API. */
function reachEvents(c: ReachContext): ReachEventSink {
  return (event) => {
    publishEntityEvent({
      c,
      entityType: event.entityType,
      action: event.action,
      entityId: event.entityId,
      data: event.data,
      changes: event.changes ?? undefined,
    });
  };
}

/** Tell the send sweep when this workspace next has outreach due (its D1 index is keyed by Clerk org id). */
function reachDue(c: ReachContext): ReachDuePort {
  const { clerkOrgId } = reachRequest(c);
  return (kind, at) => markWorkspaceDue(c.env.SCHEDULE_INDEX, kind, clerkOrgId, at);
}

/**
 * Dependencies of the write functions (campaigns, prospects, suppressions):
 * one object satisfies every one of their deps types, each takes what it names.
 */
export function reachDeps(c: ReachContext) {
  return {
    db: c.get('tenantDb'),
    emit: reachEvents(c),
    onDue: reachDue(c),
    userId: c.get('userId'),
    limits: resolveWeldReachLimits(reachRequest(c).access.limits),
  };
}

/** Mailbox reads show the warmup pool's numbers; master is opened only when there is a mailbox to show them for. */
export function reachMailboxReads(c: ReachContext): MailboxReadDeps {
  return {
    db: c.get('tenantDb'),
    warmup: { clerkOrgId: reachRequest(c).clerkOrgId, master: () => createMasterDb(c.env.HYPERDRIVE_MASTER) },
  };
}

/** Where raw inbound replies are kept (`reach/<orgId>/<messageId>.eml`): the shared `STORAGE` bucket. */
export function reachInboxStorage(c: ReachContext): ReplyStorage {
  return { STORAGE: c.env.STORAGE };
}

/**
 * Global kill switch (Flagship `weldreach-sending`, default on): off means no
 * SMTP anywhere. Without the Flagship binding the catalog default applies.
 */
export async function reachSendingEnabled(c: ReachContext): Promise<boolean> {
  const { clerkOrgId } = reachRequest(c);
  const context: FlagsContext = {
    env: c.env,
    get: ((key: string) => (key === 'userId' ? c.get('userId') : clerkOrgId)) as FlagsContext['get'],
  };
  return (await getFlags(context)).isOn('weldreach-sending');
}

/** Dependencies of `sendReply`: the keys that open the mailbox login, the access row (billing) and the kill switch. */
export function reachReplyDeps(c: ReachContext): SendReplyDeps {
  return {
    env: { DATABASE_ENCRYPTION_KEY: c.env.DATABASE_ENCRYPTION_KEY, DATABASE_ENCRYPTION_KEY_V2: c.env.DATABASE_ENCRYPTION_KEY_V2 },
    db: c.get('tenantDb'),
    access: reachRequest(c).access,
    sendingEnabled: () => reachSendingEnabled(c),
  };
}

// ---------------------------------------------------------------------------
// Request and response shaping
// ---------------------------------------------------------------------------

/**
 * `zValidator` hook: a request that fails validation is the documented
 * `{ error: { code: 'BAD_REQUEST', message, details } }` (the library's own
 * default body is not).
 */
export function reachValidation<P extends string>(result: { success: boolean; error?: ZodError }, c: Context<HonoEnv, P>) {
  if (result.success) return undefined;
  return c.json({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: result.error?.issues } }, 400);
}

/**
 * The Mailpool columns of a domain or mailbox row. The provider is an
 * implementation detail of WeldReach, so its ids are not part of the public
 * API: whatever the domain's DTO carries now or later, none leaves this worker.
 */
export type WithoutMailpool<T> = Omit<T, Extract<keyof T, `mailpool${string}`>>;

export function withoutMailpool<T extends object>(row: T): WithoutMailpool<T> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.toLowerCase().startsWith('mailpool'))) as WithoutMailpool<T>;
}

/**
 * `app.onError` of the reach router: a `ReachDomainError` is the refusal the
 * domain meant (`{ error: { code, message, details? } }` with its status, the
 * same code and status as reach-api); anything else is this worker's normal
 * error handling.
 */
export function reachErrorHandler(err: Error, c: Context): Response | Promise<Response> {
  if (!(err instanceof ReachDomainError)) return errorHandler(err, c);
  // 502 and 503 are states of a provider or of the kill switch (one line, no stack); only a 500 is a bug of ours.
  if (err.status === 500) console.error(`[external-api/reach] ${err.code}:`, err);
  else if (err.status >= 502) console.warn(`[external-api/reach] ${err.status} ${err.code}: ${err.message}`);
  return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
}
