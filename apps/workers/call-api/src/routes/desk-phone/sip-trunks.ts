/**
 * WeldDesk phone: a customer's own phone system (SIP trunk / PBX such as
 * Xelion or Dstny). Mounted at /api/desk/phone/sip-trunks.
 *
 *   GET    /                                      conversations:read  trunks with numbers and connection details
 *   POST   /                                      settings:manage     create (credentials shown once)
 *   PATCH  /:id                                   settings:manage
 *   DELETE /:id                                   settings:manage
 *   POST   /:id/rotate-password                   settings:manage     new password, shown once
 *   POST   /:id/numbers                           settings:manage
 *   DELETE /:id/numbers/:numberId                 settings:manage
 *   POST   /:id/numbers/:numberId/verification          settings:manage  { method }
 *   POST   /:id/numbers/:numberId/verification/confirm  settings:manage  { code }
 *
 * Codes are sent and tried a limited number of times an hour: over that the
 * two verification routes answer 429 `too_many_attempts` with `Retry-After`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  addDeskSipTrunkNumberSchema,
  confirmDeskSipVerificationSchema,
  createDeskSipTrunkSchema,
  startDeskSipVerificationSchema,
  updateDeskSipTrunkSchema,
} from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { error, list, noContent, success, cursorPagination } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import type { TelnyxEnv } from '../../lib/telnyx';
import {
  SipTrunkError,
  addTrunkNumber,
  confirmNumberVerification,
  createSipTrunk,
  deleteSipTrunk,
  listSipTrunks,
  removeTrunkNumber,
  rotateSipTrunkPassword,
  startNumberVerification,
  toNumberJson,
  updateSipTrunk,
  type SipTrunkContext,
  type SipTrunkRow,
  type SipTrunkNumberRow,
} from '../../services/sip-trunks';

const app = new Hono<{ Bindings: Env & TelnyxEnv; Variables: Variables }>();

type C = Context<{ Bindings: Env & TelnyxEnv; Variables: Variables }>;

function ctxOf(c: C): SipTrunkContext {
  return {
    env: c.env,
    db: c.get('tenantDb'),
    workspaceId: c.get('clerkOrgId'),
    userId: c.get('userId') ?? null,
  };
}

/** Refusals the settings screen tells apart by `details.reason` as well as by code. */
const REASON_CODES = new Set(['number_taken', 'too_many_attempts']);

/** The service's refusal as the API's error envelope; anything else is rethrown. */
function refuse(c: C, err: unknown) {
  if (err instanceof SipTrunkError) {
    if (err.status === 404) return error.notFound(c, 'Phone system');
    const reason = REASON_CODES.has(err.code) ? { details: { reason: err.code } } : {};
    const body = { error: { code: err.code, message: err.message, ...reason } };
    if (err.retryAfter !== undefined) return c.json(body, err.status, { 'Retry-After': String(err.retryAfter) });
    return c.json(body, err.status);
  }
  throw err;
}

function trunkEvent(c: C, action: 'created' | 'updated' | 'deleted', row: SipTrunkRow) {
  publishEntityEvent({
    c,
    entityType: 'sip_trunk',
    action,
    entityId: row.id,
    data: { id: row.id, name: row.name, provider: row.provider, status: row.status },
  });
}

function numberEvent(c: C, action: 'created' | 'updated' | 'deleted', row: SipTrunkNumberRow) {
  publishEntityEvent({
    c,
    entityType: 'voip_phone_number',
    action,
    entityId: row.id,
    data: { id: row.id, phoneNumber: row.phoneNumber, status: row.status },
  });
}

app.get('/', requirePermission('conversations:read'), async (c) => {
  const data = await listSipTrunks(ctxOf(c));
  return list(c, data, cursorPagination(data.length, false, null));
});

app.post('/', requirePermission('settings:manage'), zValidator('json', createDeskSipTrunkSchema), async (c) => {
  try {
    const created = await createSipTrunk(ctxOf(c), c.req.valid('json'));
    trunkEvent(c, 'created', created.row);
    return success(c, { ...created.trunk, credentials: created.credentials }, 201);
  } catch (err) {
    return refuse(c, err);
  }
});

app.patch('/:id', requirePermission('settings:manage'), zValidator('json', updateDeskSipTrunkSchema), async (c) => {
  try {
    const updated = await updateSipTrunk(ctxOf(c), c.req.param('id'), c.req.valid('json'));
    trunkEvent(c, 'updated', updated.row);
    return success(c, updated.trunk);
  } catch (err) {
    return refuse(c, err);
  }
});

app.delete('/:id', requirePermission('settings:manage'), async (c) => {
  try {
    const removed = await deleteSipTrunk(ctxOf(c), c.req.param('id'));
    for (const number of removed.numbers) numberEvent(c, 'deleted', number);
    trunkEvent(c, 'deleted', removed.row);
    return noContent(c);
  } catch (err) {
    return refuse(c, err);
  }
});

app.post('/:id/rotate-password', requirePermission('settings:manage'), async (c) => {
  try {
    const rotated = await rotateSipTrunkPassword(ctxOf(c), c.req.param('id'));
    trunkEvent(c, 'updated', rotated.row);
    return success(c, { credentials: rotated.credentials });
  } catch (err) {
    return refuse(c, err);
  }
});

app.post(
  '/:id/numbers',
  requirePermission('settings:manage'),
  zValidator('json', addDeskSipTrunkNumberSchema),
  async (c) => {
    try {
      const added = await addTrunkNumber(ctxOf(c), c.req.param('id'), c.req.valid('json'));
      numberEvent(c, 'created', added.number);
      return success(c, toNumberJson(added.number), 201);
    } catch (err) {
      return refuse(c, err);
    }
  },
);

app.delete('/:id/numbers/:numberId', requirePermission('settings:manage'), async (c) => {
  try {
    const removed = await removeTrunkNumber(ctxOf(c), c.req.param('id'), c.req.param('numberId'));
    numberEvent(c, 'deleted', removed.number);
    return noContent(c);
  } catch (err) {
    return refuse(c, err);
  }
});

app.post(
  '/:id/numbers/:numberId/verification',
  requirePermission('settings:manage'),
  zValidator('json', startDeskSipVerificationSchema),
  async (c) => {
    try {
      const started = await startNumberVerification(
        ctxOf(c),
        c.req.param('id'),
        c.req.param('numberId'),
        c.req.valid('json').method,
      );
      return success(c, started);
    } catch (err) {
      return refuse(c, err);
    }
  },
);

app.post(
  '/:id/numbers/:numberId/verification/confirm',
  requirePermission('settings:manage'),
  zValidator('json', confirmDeskSipVerificationSchema),
  async (c) => {
    try {
      const done = await confirmNumberVerification(
        ctxOf(c),
        c.req.param('id'),
        c.req.param('numberId'),
        c.req.valid('json').code,
      );
      numberEvent(c, 'updated', done.number);
      return success(c, toNumberJson(done.number));
    } catch (err) {
      return refuse(c, err);
    }
  },
);

export { app as deskPhoneSipTrunkRoutes };
export default app;
