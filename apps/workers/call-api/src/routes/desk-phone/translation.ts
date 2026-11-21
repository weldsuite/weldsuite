/**
 * WeldDesk phone: live translation of a call. Mounted at /api/desk/phone/calls.
 *
 *   GET    /:callId/translation   conversations:read    { data: state | null }
 *   POST   /:callId/translation   conversations:update  body { callerLanguage | 'auto', agentLanguage, speakToCaller? } → state
 *   PATCH  /:callId/translation   conversations:update  same fields, partial → state
 *   DELETE /:callId/translation   conversations:update  → the stopped state
 *
 * The call must be an inbound call that is live and was answered by the calling
 * member: 409 with `details.reason` (`not_live`, `not_your_call`,
 * `already_translating`, `not_translating`) otherwise. 402 when the wallet is
 * empty, 503 `ai_unavailable` without the AI gateway, 502 when Telnyx refuses
 * the transcription. Global only (feature `desk-ai`): Rust answers 503 and
 * these routes are excluded from its conformance suite.
 *
 * No entity events: a call's translation is not a catalogued entity; its lines
 * go to the realtime topic `inbox.<userId>` and, with recording on, to the
 * call's desk conversation.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  startCallTranslationSchema,
  updateCallTranslationSchema,
} from '@weldsuite/core-api-client/schemas/desk-call-translation';
import { InsufficientAiCreditsError } from '@weldsuite/core-domain/ai-billing';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import type { TelnyxEnv } from '../../lib/telnyx';
import { loadCall, type PhoneCtx } from '../../services/desk-phone-ring';
import {
  CallTranslationError,
  startTranslation,
  stopTranslation,
  toTranslationState,
  updateTranslation,
} from '../../services/desk-phone-translation';

type AppContext = Context<{ Bindings: Env & TelnyxEnv; Variables: Variables }>;

const app = new Hono<{ Bindings: Env & TelnyxEnv; Variables: Variables }>();

/** The Clerk org id is what client_state and realtime key on. */
function phoneCtx(c: AppContext): PhoneCtx {
  return { env: c.env, db: c.get('tenantDb'), workspaceId: c.get('clerkOrgId') };
}

function refuse(c: AppContext, err: unknown) {
  if (err instanceof InsufficientAiCreditsError) {
    return error.insufficientCredits(c, {
      currentBalance: err.currentBalance,
      required: err.required,
      shortfall: err.shortfall,
    });
  }
  if (err instanceof CallTranslationError) {
    switch (err.code) {
      case 'ai_unavailable':
        return c.json({ error: { code: 'ai_unavailable', message: err.message } }, 503);
      case 'telnyx_failed':
        return error.badGateway(c, err.message);
      case 'not_found':
        return error.notFound(c, 'Call');
      default:
        return error.conflict(c, err.message, { reason: err.code });
    }
  }
  console.error('[desk-phone] call translation failed:', err);
  return error.internal(c, 'Failed to translate the call');
}

app.get('/:callId/translation', requirePermission('conversations:read'), async (c) => {
  const callId = c.req.param('callId');
  const call = await loadCall(c.get('tenantDb'), callId);
  if (!call) return error.notFound(c, 'Call', callId);
  return success(c, call.translation ? toTranslationState(call.id, call.translation) : null);
});

app.post(
  '/:callId/translation',
  requirePermission('conversations:update'),
  zValidator('json', startCallTranslationSchema),
  async (c) => {
    const callId = c.req.param('callId');
    const ctx = phoneCtx(c);
    const call = await loadCall(ctx.db, callId);
    if (!call) return error.notFound(c, 'Call', callId);
    try {
      const started = await startTranslation(ctx, call, c.get('userId'), c.req.valid('json'));
      return success(c, toTranslationState(call.id, started));
    } catch (err) {
      return refuse(c, err);
    }
  },
);

app.patch(
  '/:callId/translation',
  requirePermission('conversations:update'),
  zValidator('json', updateCallTranslationSchema),
  async (c) => {
    const callId = c.req.param('callId');
    const ctx = phoneCtx(c);
    const call = await loadCall(ctx.db, callId);
    if (!call) return error.notFound(c, 'Call', callId);
    try {
      const updated = await updateTranslation(ctx, call, c.get('userId'), c.req.valid('json'));
      return success(c, toTranslationState(call.id, updated));
    } catch (err) {
      return refuse(c, err);
    }
  },
);

app.delete('/:callId/translation', requirePermission('conversations:update'), async (c) => {
  const callId = c.req.param('callId');
  const ctx = phoneCtx(c);
  const call = await loadCall(ctx.db, callId);
  if (!call) return error.notFound(c, 'Call', callId);
  if (call.answeredByUserId !== c.get('userId')) {
    return error.conflict(c, 'Only the member who answered can translate this call', { reason: 'not_your_call' });
  }
  if (!call.translation || call.translation.stoppedAt) {
    return error.conflict(c, 'The call is not being translated', { reason: 'not_translating' });
  }
  try {
    const stopped = await stopTranslation(ctx, call);
    if (!stopped) return error.conflict(c, 'The call is not being translated', { reason: 'not_translating' });
    return success(c, toTranslationState(call.id, stopped));
  } catch (err) {
    return refuse(c, err);
  }
});

export { app as deskPhoneTranslationRoutes };
export default app;
