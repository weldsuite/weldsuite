/** Helpers the envelope routes share: the viewer, error mapping and the entity event. */

import type { Context } from 'hono';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { DataFor } from '@weldsuite/entity-events/events';
import { error } from '@weldsuite/worker-kit/response';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { SignError, invalid } from '@weldsuite/sign-domain/errors';
import { MeterLimitError } from '@weldsuite/credits/meters';
import { getEnvelopeDetail, memberProfile, type DetailAccess, type SignViewer } from '@weldsuite/sign-domain/envelopes';
import type { Actor, SendContext } from '@weldsuite/sign-domain/sending';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function viewerOf(c: Ctx): Promise<SignViewer> {
  const userId = c.get('userId') ?? '';
  const [manageAll, profile] = await Promise.all([
    hasContextPermission(c, 'sign_envelopes:manage'),
    userId ? memberProfile(c.get('tenantDb'), userId) : Promise.resolve({ email: null }),
  ]);
  return { userId, email: profile.email?.toLowerCase() ?? null, manageAll };
}

/** Whether the caller holds a permission named at run time (a source's read permission). */
export async function mayDo(c: Ctx, permission: string): Promise<boolean> {
  return hasContextPermission(c, permission as Parameters<typeof hasContextPermission>[1]);
}

/** The viewer and what they may do, for the detail's action flags. */
export async function accessOf(c: Ctx, viewer?: SignViewer): Promise<DetailAccess> {
  const writable = !c.get('readOnly');
  const [who, update, send, voidAllowed] = await Promise.all([
    viewer ?? viewerOf(c),
    hasContextPermission(c, 'sign_envelopes:update'),
    hasContextPermission(c, 'sign_envelopes:send'),
    hasContextPermission(c, 'sign_envelopes:void'),
  ]);
  return { viewer: who, update: writable && update, send: writable && send, void: writable && voidAllowed };
}

/** What sending and the lifecycle need: the tenant and master DBs and both workspace ids. */
export function sendContextOf(c: Ctx): SendContext {
  const clerkOrgId = c.get('clerkOrgId');
  const workspaceId = c.get('workspaceId');
  if (!clerkOrgId || !workspaceId) throw invalid('No workspace selected');
  return { env: c.env, db: c.get('tenantDb'), master: getMasterDb(c.env), clerkOrgId, workspaceId };
}

/** The member acting, as recorded on the evidence trail. */
export async function actorOf(c: Ctx): Promise<Actor> {
  const userId = c.get('userId') ?? null;
  const profile = userId ? await memberProfile(c.get('tenantDb'), userId) : { name: null, email: null };
  return { userId, ...profile };
}

/** The envelope as the caller sees it. */
export async function detailFor(c: Ctx, envelope: SignEnvelope, viewer?: SignViewer): Promise<SignEnvelopeDetail> {
  return getEnvelopeDetail(c.get('tenantDb'), envelope, await accessOf(c, viewer));
}

/** Turn a service error into the API's error envelope; rethrow anything else. */
export function respondToSignError(c: Ctx, err: unknown): Response {
  if (err instanceof MeterLimitError) {
    const { meter, used, allowance, required, currentBalance } = err.result;
    return error.paymentRequired(c, err.code, err.message, { meter, used, allowance, required, currentBalance });
  }
  if (!(err instanceof SignError)) throw err;
  if (err.kind === 'not_found') return error.notFound(c, err.resource ?? 'Resource');
  if (err.kind === 'conflict') return error.conflict(c, err.message);
  return error.badRequest(c, err.message);
}

/** Run a handler, answering service errors as API errors. */
export async function handle(c: Ctx, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return respondToSignError(c, err);
  }
}

/** The `sign_envelope` event payload: ids, title and status only (EVT-005). */
export function envelopeEventData(envelope: SignEnvelope): DataFor<'sign_envelope'> {
  return { id: envelope.id, title: envelope.title, status: envelope.status, senderUserId: envelope.senderUserId };
}

/** `sign_envelope:updated` after a change to a draft's documents, recipients or fields, or a sent request's recipients. */
export function publishEnvelopeUpdated(c: Ctx, envelope: SignEnvelope): void {
  publishEntityEvent({ c, entityType: 'sign_envelope', entityId: envelope.id, action: 'updated', data: envelopeEventData(envelope) });
}
