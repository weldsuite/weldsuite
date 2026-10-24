/** Helpers the envelope routes share: the viewer, error mapping and the entity event. */

import type { Context } from 'hono';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { DataFor } from '@weldsuite/entity-events/events';
import { error } from '@weldsuite/worker-kit/response';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { SignError } from '../../services/errors';
import type { SignViewer } from '../../services/envelopes';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function viewerOf(c: Ctx): Promise<SignViewer> {
  return {
    userId: c.get('userId') ?? '',
    manageAll: await hasContextPermission(c, 'sign_envelopes:manage'),
  };
}

/** Whether the caller may change drafts at all (the envelope itself must still be a draft). */
export async function mayEdit(c: Ctx): Promise<boolean> {
  return !c.get('readOnly') && (await hasContextPermission(c, 'sign_envelopes:update'));
}

/** Turn a service error into the API's error envelope; rethrow anything else. */
export function respondToSignError(c: Ctx, err: unknown): Response {
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

/** `sign_envelope:updated` after a change to a draft's documents, recipients or fields. */
export function publishEnvelopeUpdated(c: Ctx, envelope: SignEnvelope): void {
  publishEntityEvent({ c, entityType: 'sign_envelope', entityId: envelope.id, action: 'updated', data: envelopeEventData(envelope) });
}
