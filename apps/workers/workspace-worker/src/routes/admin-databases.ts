/**
 * /api/internal/admin: the admin console's view of, and control over, where
 * tenant databases live (TASK-1150, ADR DATA-016).
 *
 *   POST /workspaces/:workspaceId/database-moves   start a move        (superadmin)
 *   POST /database-moves/:moveId/cancel            ask a move to stop  (superadmin)
 *   POST /database-moves/:moveId/recover           undo a stuck move   (superadmin)
 *   GET  /database-moves/:moveId                   one move, for polling
 *   GET  /workspaces/:workspaceId/database-moves   the workspace's recent moves
 *   GET  /databases/live                           Neon compute state of every shard
 *   GET  /databases/shards/:shardId/sizes          size of each database in a shard (not viewers)
 *
 * Auth is `adminAuth()` (shared secret + the admin's identity and role); every
 * route that changes something needs a superadmin. Every mutating route writes
 * an `admin_audit_events` row, failures included, attributed to the acting
 * admin; the Workflow adds `database.move_complete` / `database.move_fail`
 * when the move ends.
 *
 * Bodies and responses follow the worker-kit shape: `{ data }` and
 * `{ error: { code, message } }`. Move rows are projected (projection.ts):
 * never the encrypted target URL, never the saved copy state or the checksums.
 * `/databases/shards/:shardId/sizes` runs a query on the shard and so WAKES its
 * compute if suspended: it is a separate call the console makes on request,
 * never part of a page load (`/databases/live` only asks the Neon API).
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createNeonClient, createProvisioningService } from '@weldsuite/neon-provisioning';
import type { Env } from '../index';
import { getMasterDb, type MasterDatabase } from '../db';
import { recordAdminAudit, type AdminAuditEntry } from '../lib/admin-audit';
import { adminAuth, type AdminVariables } from '../middleware/admin-auth';
import {
  DatabaseMoveRequestError,
  MoveFlowError,
  createMoveDeps,
  describeFailure,
  recoverDatabaseMove,
  requestMoveCancel,
  startDatabaseMove,
  startDatabaseMoveInputSchema,
  type MoveDeps,
  type MoveFlowErrorCode,
} from '../services/database-move';
import { MOVE_AUDIT_ACTIONS } from '../services/database-move/audit';
import { listMoveViews, loadMoveView } from '../services/database-move/projection';
import { loadMove } from '../services/database-move/state';
import {
  fetchLiveDatabases,
  fetchShardSizes,
  parseProjectIds,
  MAX_LIVE_PROJECT_IDS,
  type EndpointLister,
  type ShardSizeReader,
  type ShardSizesOutcome,
} from '../services/database-live';

type ErrorStatus = 400 | 403 | 404 | 409 | 422 | 500 | 502;

/** What the routes need from outside the worker, so a test can swap the Neon side and the master DB. */
export interface AdminDatabasesDeps {
  masterDb(env: Env): MasterDatabase;
  /** Dependencies of the recovery (it talks to Neon and the tenant databases). */
  moveDeps(env: Env): MoveDeps;
  endpointLister(env: Env): EndpointLister;
  shardSizeReader(env: Env): ShardSizeReader;
  now(): Date;
}

const defaultDeps: AdminDatabasesDeps = {
  masterDb: getMasterDb,
  moveDeps: createMoveDeps,
  endpointLister: (env) =>
    createNeonClient({
      NEON_API_KEY: env.NEON_API_KEY,
      NEON_ORG_ID: env.NEON_ORG_ID,
      NEON_DEFAULT_REGION: env.NEON_DEFAULT_REGION,
    }),
  shardSizeReader: (env) => {
    const provisioning = createProvisioningService({
      NEON_API_KEY: env.NEON_API_KEY,
      NEON_ORG_ID: env.NEON_ORG_ID,
      NEON_DEFAULT_REGION: env.NEON_DEFAULT_REGION,
    });
    return (shard) => provisioning.listShardDatabaseSizes(shard);
  },
  now: () => new Date(),
};

const startBodySchema = startDatabaseMoveInputSchema.pick({ target: true, reason: true });
const recoverBodySchema = z.object({ force: z.boolean().optional() });

const FLOW_ERROR_STATUS: Record<MoveFlowErrorCode, ErrorStatus> = {
  MOVE_NOT_FOUND: 404,
  MOVE_ENDED: 409,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_CHANGED: 409,
  WORKSPACE_NOT_MOVABLE: 409,
  SOURCE_NOT_CURRENT: 409,
  TARGET_LOST: 409,
  NOT_CONFIGURED: 500,
  VERIFICATION_FAILED: 409,
  COMPENSATION_INCOMPLETE: 502,
};

interface Failure {
  status: ErrorStatus;
  code: string;
  message: string;
}

/** A refusal the service chose the words of is passed on; anything else is logged and answered generically. */
function failureOf(err: unknown): Failure {
  if (err instanceof DatabaseMoveRequestError) {
    return { status: err.httpStatus, code: err.code, message: err.message };
  }
  if (err instanceof MoveFlowError) {
    return { status: FLOW_ERROR_STATUS[err.code], code: err.code, message: err.message };
  }
  console.error(`[AdminDatabases] Unexpected error: ${describeFailure(err)}`);
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Unexpected error' };
}

async function readJsonBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await req.text();
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

export function createAdminDatabaseRoutes(overrides: Partial<AdminDatabasesDeps> = {}) {
  const deps: AdminDatabasesDeps = { ...defaultDeps, ...overrides };
  const routes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

  routes.use('*', adminAuth());
  routes.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const failure = (c: AdminContext, f: Failure) =>
    c.json({ error: { code: f.code, message: f.message } }, f.status);

  /** Audit helper bound to the acting admin: records one row for this request. Never throws. */
  const auditor = (c: AdminContext, db: MasterDatabase) => {
    const actor = c.get('adminActor');
    return (entry: Omit<AdminAuditEntry, 'actor'>) =>
      recordAdminAudit(db, { actor: { email: actor.email, userId: actor.userId }, ...entry });
  };

  // ── Moves ────────────────────────────────────────────────────────────

  routes.post('/workspaces/:workspaceId/database-moves', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const actor = c.get('adminActor');
    const db = deps.masterDb(c.env);
    const record = auditor(c, db);
    const audit = (outcome: 'success' | 'failure', extra: Partial<AdminAuditEntry>) =>
      record({
        workspaceId,
        targetType: 'workspace',
        targetId: workspaceId,
        action: MOVE_AUDIT_ACTIONS.start,
        outcome,
        ...extra,
      });

    const body = await readJsonBody(c.req.raw);
    const parsed = body.ok ? startBodySchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      const message = parsed
        ? parsed.error.issues.map((issue) => issue.message).join('; ')
        : 'The request body is not valid JSON';
      await audit('failure', { error: `INVALID_INPUT: ${message}` });
      return failure(c, { status: 400, code: 'INVALID_INPUT', message });
    }
    const { target } = parsed.data;
    const reason = parsed.data.reason?.trim() || undefined;

    try {
      const started = await startDatabaseMove(
        c.env,
        {
          workspaceId,
          target,
          startedBy: actor.email,
          ...(actor.userId ? { startedByUserId: actor.userId } : {}),
          ...(reason ? { reason } : {}),
        },
        { masterDb: db },
      );
      await audit('success', { reason, details: { moveId: started.moveId, kind: started.kind, target } });
      return c.json({ data: { moveId: started.moveId, kind: started.kind } }, 202);
    } catch (err) {
      const f = failureOf(err);
      await audit('failure', { reason, details: { target }, error: `${f.code}: ${f.message}` });
      return failure(c, f);
    }
  });

  routes.post('/database-moves/:moveId/cancel', async (c) => {
    const moveId = c.req.param('moveId');
    const db = deps.masterDb(c.env);
    const record = auditor(c, db);

    const move = await loadMove(db, moveId);
    const audit = (outcome: 'success' | 'failure', extra: Partial<AdminAuditEntry>) =>
      record({
        workspaceId: move?.workspaceId ?? null,
        targetType: 'workspace',
        targetId: move?.workspaceId ?? moveId,
        action: MOVE_AUDIT_ACTIONS.cancel,
        outcome,
        ...extra,
      });
    if (!move) {
      const f: Failure = { status: 404, code: 'MOVE_NOT_FOUND', message: 'Move not found' };
      await audit('failure', { details: { moveId }, error: `${f.code}: ${f.message}` });
      return failure(c, f);
    }

    try {
      const result = await requestMoveCancel(c.env, moveId, { masterDb: db, now: deps.now });
      await audit('success', { details: { moveId, statusBefore: move.status, status: result.status } });
      return c.json({ data: { moveId, status: result.status } }, 202);
    } catch (err) {
      const f = failureOf(err);
      await audit('failure', { details: { moveId, statusBefore: move.status }, error: `${f.code}: ${f.message}` });
      return failure(c, f);
    }
  });

  routes.post('/database-moves/:moveId/recover', async (c) => {
    const moveId = c.req.param('moveId');
    const db = deps.masterDb(c.env);
    const record = auditor(c, db);

    const move = await loadMove(db, moveId);
    const audit = (outcome: 'success' | 'failure', extra: Partial<AdminAuditEntry>) =>
      record({
        workspaceId: move?.workspaceId ?? null,
        targetType: 'workspace',
        targetId: move?.workspaceId ?? moveId,
        action: MOVE_AUDIT_ACTIONS.recover,
        outcome,
        ...extra,
      });

    const body = await readJsonBody(c.req.raw);
    const parsed = body.ok ? recoverBodySchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      const message = parsed
        ? parsed.error.issues.map((issue) => issue.message).join('; ')
        : 'The request body is not valid JSON';
      await audit('failure', { details: { moveId }, error: `INVALID_INPUT: ${message}` });
      return failure(c, { status: 400, code: 'INVALID_INPUT', message });
    }
    const force = parsed.data.force === true;

    if (!move) {
      const f: Failure = { status: 404, code: 'MOVE_NOT_FOUND', message: 'Move not found' };
      await audit('failure', { details: { moveId, force }, error: `${f.code}: ${f.message}` });
      return failure(c, f);
    }

    try {
      const result = await recoverDatabaseMove(deps.moveDeps(c.env), moveId, { force });
      await audit('success', {
        details: {
          moveId,
          force,
          statusBefore: move.status,
          status: result.status,
          sourceUnlocked: result.sourceUnlocked,
          targetReleased: result.targetReleased,
        },
      });
      return c.json(
        {
          data: {
            moveId,
            status: result.status,
            sourceUnlocked: result.sourceUnlocked,
            targetReleased: result.targetReleased,
          },
        },
        200,
      );
    } catch (err) {
      const f = failureOf(err);
      await audit('failure', { details: { moveId, force, statusBefore: move.status }, error: `${f.code}: ${f.message}` });
      return failure(c, f);
    }
  });

  routes.get('/database-moves/:moveId', async (c) => {
    const view = await loadMoveView(deps.masterDb(c.env), c.req.param('moveId'));
    if (!view) return failure(c, { status: 404, code: 'MOVE_NOT_FOUND', message: 'Move not found' });
    return c.json({ data: view });
  });

  routes.get('/workspaces/:workspaceId/database-moves', async (c) => {
    const views = await listMoveViews(deps.masterDb(c.env), c.req.param('workspaceId'));
    return c.json({ data: views });
  });

  // ── Live state ───────────────────────────────────────────────────────

  routes.get('/databases/live', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projectIds'));
    if (!projectIds) {
      return failure(c, {
        status: 400,
        code: 'INVALID_INPUT',
        message: `projectIds must be at most ${MAX_LIVE_PROJECT_IDS} comma-separated Neon project ids`,
      });
    }
    const live = await fetchLiveDatabases(deps.masterDb(c.env), deps.endpointLister(c.env), projectIds, deps.now);
    return c.json({ data: live });
  });

  routes.get('/databases/shards/:shardId/sizes', async (c) => {
    // Reading sizes wakes the shard's compute, which costs money: not for viewers.
    if (c.get('adminActor').role === 'viewer') {
      return failure(c, { status: 403, code: 'FORBIDDEN', message: 'Viewers cannot measure shard sizes' });
    }
    let outcome: ShardSizesOutcome;
    try {
      outcome = await fetchShardSizes(deps.masterDb(c.env), deps.shardSizeReader(c.env), c.req.param('shardId'));
    } catch (err) {
      console.error(`[AdminDatabases] Reading shard sizes failed: ${describeFailure(err)}`);
      return failure(c, { status: 502, code: 'SHARD_QUERY_FAILED', message: 'The shard could not be queried' });
    }
    if (outcome.kind === 'shard_not_found') {
      return failure(c, { status: 404, code: 'SHARD_NOT_FOUND', message: 'Shard not found' });
    }
    if (outcome.kind === 'no_admin_access') {
      return failure(c, {
        status: 422,
        code: 'SHARD_ADMIN_UNAVAILABLE',
        message: 'This shard has no admin access recorded, so its databases cannot be measured',
      });
    }
    return c.json({ data: outcome.sizes });
  });

  return routes;
}

export const adminDatabaseRoutes = createAdminDatabaseRoutes();
