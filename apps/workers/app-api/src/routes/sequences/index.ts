/**
 * Sequences routes — flat /api/sequences/* surface backed by the `workflows`
 * table (rows tagged __type:sequence) plus `sequence_enrollments`.
 *
 * Workflow-engine actions (enroll-into-running, launch, pause/resume)
 * dispatch the EXECUTE_SEQUENCE Workflow, hosted in THIS worker since W4
 * (src/workflows/execute-sequence.ts, names `execute-sequence-v2*`).
 *
 * Permissions reuse the `contacts` object (matches legacy api-worker behavior).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { unenrollFromSequenceSchema } from '@weldsuite/core-api-client/schemas/sequences';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const w = schema.workflows;
const e = schema.sequenceEnrollments;
const p = schema.parties;

app.get('/', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 100);

  const conditions: any[] = [
    isNull(w.deletedAt),
    sql`${w.tags}::jsonb ? '__type:sequence'`,
  ];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(w.name, term), like(w.description, term))!);
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: w.createdAt, id: w.id })
      .from(w).where(eq(w.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${w.createdAt} < ${cur.createdAt} OR (${w.createdAt} = ${cur.createdAt} AND ${w.id} < ${cur.id}))`,
      );
    }
  }
  const where = and(...conditions);
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({
          id: w.id,
          name: w.name,
          description: w.description,
          status: w.status,
          steps: w.steps,
          tags: w.tags,
          executionCount: w.executionCount,
          successCount: w.successCount,
          lastExecutedAt: w.lastExecutedAt,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          enrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status != 'unenrolled')`,
          activeEnrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status = 'active')`,
          pendingEnrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status = 'pending')`,
        })
        .from(w)
        .where(where)
        .orderBy(desc(w.createdAt), desc(w.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(w).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/sequences] list failed:', err);
    return error.internal(c, 'Failed to list sequences');
  }
});

app.get('/:id', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({
        id: w.id,
        name: w.name,
        description: w.description,
        status: w.status,
        steps: w.steps,
        triggers: w.triggers,
        tags: w.tags,
        settings: w.settings,
        executionCount: w.executionCount,
        successCount: w.successCount,
        failureCount: w.failureCount,
        lastExecutedAt: w.lastExecutedAt,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        enrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status != 'unenrolled')`,
        activeEnrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status = 'active')`,
        pendingEnrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status = 'pending')`,
        completedEnrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status = 'completed')`,
        failedEnrolledCount: sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_id = ${w.id} AND status = 'failed')`,
      })
      .from(w)
      .where(and(eq(w.id, id), isNull(w.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Sequence', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/sequences] get failed:', err);
    return error.internal(c, 'Failed to fetch sequence');
  }
});

app.get('/:id/enrollments', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [eq(e.sequenceId, id), isNull(p.deletedAt)];
  if (q.status) conditions.push(eq(e.status, q.status));
  if (q.search) {
    const term = `%${q.search}%`;
    // After the companies/people refactor, party rows carry a `displayName`
    // instead of separate companyName/fullName/email columns. Search by
    // displayName; per-field search can be added back via snapshot JSONB.
    conditions.push(like(p.displayName, term));
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ enrolledAt: e.enrolledAt, id: e.id })
      .from(e).where(eq(e.id, q.cursor)).limit(1);
    if (cur?.enrolledAt) {
      conditions.push(
        sql`(${e.enrolledAt} < ${cur.enrolledAt} OR (${e.enrolledAt} = ${cur.enrolledAt} AND ${e.id} < ${cur.id}))`,
      );
    }
  }
  const where = and(...conditions);
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({
          id: e.id,
          sequenceId: e.sequenceId,
          customerId: e.customerId,
          status: e.status,
          executionId: e.executionId,
          currentStepIndex: e.currentStepIndex,
          totalSteps: e.totalSteps,
          enrolledBy: e.enrolledBy,
          enrolledAt: e.enrolledAt,
          completedAt: e.completedAt,
          pausedAt: e.pausedAt,
          unenrolledAt: e.unenrolledAt,
          failedAt: e.failedAt,
          errorMessage: e.errorMessage,
          customerSnapshot: e.customerSnapshot,
          customerEmail: sql<string | null>`${e.customerSnapshot}->>'email'`,
          customerFullName: sql<string | null>`coalesce(${e.customerSnapshot}->>'fullName', ${p.displayName})`,
          customerCompanyName: sql<string | null>`${e.customerSnapshot}->>'companyName'`,
        })
        .from(e)
        .innerJoin(p, eq(e.customerId, p.id))
        .where(where)
        .orderBy(desc(e.enrolledAt), desc(e.id))
        .limit(limit + 1),
      db
        .select({ count: sql<number>`count(*)` })
        .from(e)
        .innerJoin(p, eq(e.customerId, p.id))
        .where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/sequences] list enrollments failed:', err);
    return error.internal(c, 'Failed to list enrollments');
  }
});

/**
 * DELETE /sequences/enrollments/:enrollmentId — mark an enrollment as
 * `unenrolled`. Does not interact with the workflow engine; a running
 * workflow will see the status flip and short-circuit on its next step.
 */
app.delete('/enrollments/:enrollmentId', requirePermission('contacts:update'), async (c) => {
  const db = c.get('tenantDb');
  const enrollmentId = c.req.param('enrollmentId');
  try {
    const [existing] = await db.select().from(e).where(eq(e.id, enrollmentId)).limit(1);
    if (!existing) return error.notFound(c, 'Enrollment', enrollmentId);
    await db
      .update(e)
      .set({ status: 'unenrolled', unenrolledAt: new Date() })
      .where(eq(e.id, enrollmentId));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/sequences] unenroll failed:', err);
    return error.internal(c, 'Failed to unenroll');
  }
});

// Acknowledge the body schema export so tooling sees it used; the field is
// sent by the client when unenrolling for logging purposes and will be wired
// through when the audit-events binding is added to app-api.
void unenrollFromSequenceSchema;

// ============================================================================
// Workflow-engine actions — enroll, launch, start, pause/resume sequence,
// pause/resume enrollment. App-api owns the DB writes; the durable execution
// runs in the self-hosted EXECUTE_SEQUENCE workflow (execute-sequence-v2*)
// configured in wrangler.toml.
// ============================================================================

/**
 * Fire EXECUTE_SEQUENCE for one enrollment and return the workflow instance
 * id (or `null` if the binding isn't configured in the current env). Wrapped
 * in try/catch so a single failed trigger doesn't abort a bulk enroll loop —
 * the enrollment row stays in the DB and can be retried by `start`.
 */
async function triggerSequenceWorkflow(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  params: {
    workspaceId: string;
    userId: string;
    sequenceId: string;
    enrollmentId: string;
    customerId: string;
  },
): Promise<string | null> {
  const binding = c.env.EXECUTE_SEQUENCE;
  if (!binding) {
    console.warn('[app-api/sequences] EXECUTE_SEQUENCE binding missing — skipping workflow trigger');
    return null;
  }
  try {
    const instance = await binding.create({ params });
    return instance.id;
  } catch (err) {
    console.error('[app-api/sequences] EXECUTE_SEQUENCE.create failed:', err);
    return null;
  }
}

const enrollSchema = z.object({
  customerIds: z.array(z.string()).min(1),
});

/**
 * POST /sequences/:id/enroll — bulk-enroll customers. Each new row starts as
 * `pending` if the sequence is still a draft, or `active` (and triggers the
 * workflow immediately) if the sequence is already running. The
 * `(sequenceId, customerId)` unique constraint makes the call idempotent —
 * re-enrolling an existing customer no-ops without erroring.
 */
app.post(
  '/:id/enroll',
  requirePermission('contacts:create'),
  zValidator('json', enrollSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    const sequenceId = c.req.param('id');
    const { customerIds } = c.req.valid('json');

    try {
      const [sequence] = await db
        .select({ id: w.id, status: w.status })
        .from(w)
        .where(and(eq(w.id, sequenceId), isNull(w.deletedAt)))
        .limit(1);
      if (!sequence) return error.notFound(c, 'Sequence', sequenceId);

      const isActiveSequence = sequence.status === 'active';
      const ids = Array.from(new Set(customerIds));

      const parties = await db
        .select({
          id: p.id,
          displayName: p.displayName,
        })
        .from(p)
        .where(and(inArray(p.id, ids), isNull(p.deletedAt)));
      const partyById = new Map(parties.map((row) => [row.id, row]));

      const alreadyEnrolled = await db
        .select({ customerId: e.customerId })
        .from(e)
        .where(and(eq(e.sequenceId, sequenceId), inArray(e.customerId, ids)));
      const enrolledSet = new Set(alreadyEnrolled.map((r) => r.customerId));

      const toEnroll = ids.filter((id) => partyById.has(id) && !enrolledSet.has(id));
      if (toEnroll.length === 0) {
        return success(c, { enrolled: 0, enrollmentIds: [] });
      }

      const now = new Date();
      const enrollmentRows = toEnroll.map((customerId) => {
        const party = partyById.get(customerId)!;
        return {
          id: generateId('senr'),
          sequenceId,
          customerId,
          counterpartyId: customerId,
          status: isActiveSequence ? 'active' : 'pending',
          enrolledBy: userId,
          enrolledAt: now,
          customerSnapshot: party.displayName
            ? { fullName: party.displayName, companyName: party.displayName }
            : null,
        };
      });

      await db.insert(e).values(enrollmentRows);

      if (isActiveSequence) {
        for (const row of enrollmentRows) {
          const instanceId = await triggerSequenceWorkflow(c, {
            workspaceId,
            userId,
            sequenceId,
            enrollmentId: row.id,
            customerId: row.customerId,
          });
          if (instanceId) {
            await db.update(e).set({ executionId: instanceId }).where(eq(e.id, row.id));
          }
        }
      }

      return success(c, {
        enrolled: enrollmentRows.length,
        enrollmentIds: enrollmentRows.map((r) => r.id),
      });
    } catch (err) {
      console.error('[app-api/sequences] enroll failed:', err);
      return error.internal(c, 'Failed to enroll customers');
    }
  },
);

/**
 * POST /sequences/:id/launch — activate a draft sequence. Flips the workflow
 * status to `active`, converts every `pending` enrollment to `active`, and
 * triggers EXECUTE_SEQUENCE for each newly-active enrollment.
 */
app.post('/:id/launch', requirePermission('contacts:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const sequenceId = c.req.param('id');

  try {
    const [sequence] = await db
      .select({ id: w.id, status: w.status })
      .from(w)
      .where(and(eq(w.id, sequenceId), isNull(w.deletedAt)))
      .limit(1);
    if (!sequence) return error.notFound(c, 'Sequence', sequenceId);

    await db
      .update(w)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(w.id, sequenceId));

    const pending = await db
      .select({ id: e.id, customerId: e.customerId })
      .from(e)
      .where(and(eq(e.sequenceId, sequenceId), eq(e.status, 'pending')));

    if (pending.length > 0) {
      await db
        .update(e)
        .set({ status: 'active' })
        .where(
          and(eq(e.sequenceId, sequenceId), eq(e.status, 'pending')),
        );

      for (const row of pending) {
        const instanceId = await triggerSequenceWorkflow(c, {
          workspaceId,
          userId,
          sequenceId,
          enrollmentId: row.id,
          customerId: row.customerId,
        });
        if (instanceId) {
          await db.update(e).set({ executionId: instanceId }).where(eq(e.id, row.id));
        }
      }
    }

    publishEntityEvent({
      c,
      entityType: 'sequence',
      entityId: sequenceId,
      action: 'updated',
      data: { id: sequenceId, status: 'active' },
    });
    return success(c, { activated: pending.length });
  } catch (err) {
    console.error('[app-api/sequences] launch failed:', err);
    return error.internal(c, 'Failed to launch sequence');
  }
});

/**
 * POST /sequences/:id/start — re-trigger workflow execution for every active
 * enrollment that has no live `executionId`. Does NOT flip the sequence's
 * workflow status (use `launch` for that). Idempotent for already-running
 * enrollments.
 */
app.post('/:id/start', requirePermission('contacts:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const sequenceId = c.req.param('id');

  try {
    const [sequence] = await db
      .select({ id: w.id })
      .from(w)
      .where(and(eq(w.id, sequenceId), isNull(w.deletedAt)))
      .limit(1);
    if (!sequence) return error.notFound(c, 'Sequence', sequenceId);

    const active = await db
      .select({ id: e.id, customerId: e.customerId, executionId: e.executionId })
      .from(e)
      .where(and(eq(e.sequenceId, sequenceId), eq(e.status, 'active')));

    const toTrigger = active.filter((row) => !row.executionId);
    for (const row of toTrigger) {
      const instanceId = await triggerSequenceWorkflow(c, {
        workspaceId,
        userId,
        sequenceId,
        enrollmentId: row.id,
        customerId: row.customerId,
      });
      if (instanceId) {
        await db.update(e).set({ executionId: instanceId }).where(eq(e.id, row.id));
      }
    }

    return success(c, { triggered: toTrigger.length });
  } catch (err) {
    console.error('[app-api/sequences] start failed:', err);
    return error.internal(c, 'Failed to start sequence');
  }
});

/**
 * POST /sequences/:id/pause — flip the sequence's workflow row to `paused`.
 * The workflow runtime checks status on every step and short-circuits, so we
 * don't need to actively cancel running instances.
 */
app.post('/:id/pause', requirePermission('contacts:update'), async (c) => {
  const db = c.get('tenantDb');
  const sequenceId = c.req.param('id');

  try {
    const [sequence] = await db
      .select({ id: w.id })
      .from(w)
      .where(and(eq(w.id, sequenceId), isNull(w.deletedAt)))
      .limit(1);
    if (!sequence) return error.notFound(c, 'Sequence', sequenceId);

    await db
      .update(w)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(w.id, sequenceId));
    publishEntityEvent({
      c,
      entityType: 'sequence',
      entityId: sequenceId,
      action: 'updated',
      data: { id: sequenceId, status: 'paused' },
    });
    return success(c, { paused: true });
  } catch (err) {
    console.error('[app-api/sequences] pause sequence failed:', err);
    return error.internal(c, 'Failed to pause sequence');
  }
});

/**
 * PATCH /sequences/:sequenceId/enrollments/:enrollmentId/pause — DB-only
 * status flip. The workflow sees `paused` on its next step and short-circuits.
 */
app.patch(
  '/:sequenceId/enrollments/:enrollmentId/pause',
  requirePermission('contacts:update'),
  async (c) => {
    const db = c.get('tenantDb');
    const sequenceId = c.req.param('sequenceId');
    const enrollmentId = c.req.param('enrollmentId');

    try {
      const [existing] = await db
        .select({ id: e.id })
        .from(e)
        .where(and(eq(e.id, enrollmentId), eq(e.sequenceId, sequenceId)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Enrollment', enrollmentId);

      await db
        .update(e)
        .set({ status: 'paused', pausedAt: new Date() })
        .where(eq(e.id, enrollmentId));
      return success(c, { paused: true });
    } catch (err) {
      console.error('[app-api/sequences] pause enrollment failed:', err);
      return error.internal(c, 'Failed to pause enrollment');
    }
  },
);

/**
 * PATCH /sequences/:sequenceId/enrollments/:enrollmentId/resume — clear the
 * paused flag and re-trigger EXECUTE_SEQUENCE if the enrollment has no live
 * workflow instance.
 */
app.patch(
  '/:sequenceId/enrollments/:enrollmentId/resume',
  requirePermission('contacts:update'),
  async (c) => {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    const sequenceId = c.req.param('sequenceId');
    const enrollmentId = c.req.param('enrollmentId');

    try {
      const [existing] = await db
        .select({
          id: e.id,
          customerId: e.customerId,
          executionId: e.executionId,
        })
        .from(e)
        .where(and(eq(e.id, enrollmentId), eq(e.sequenceId, sequenceId)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Enrollment', enrollmentId);

      await db
        .update(e)
        .set({ status: 'active', pausedAt: null })
        .where(eq(e.id, enrollmentId));

      if (!existing.executionId) {
        const instanceId = await triggerSequenceWorkflow(c, {
          workspaceId,
          userId,
          sequenceId,
          enrollmentId,
          customerId: existing.customerId,
        });
        if (instanceId) {
          await db.update(e).set({ executionId: instanceId }).where(eq(e.id, enrollmentId));
        }
      }

      return success(c, { resumed: true });
    } catch (err) {
      console.error('[app-api/sequences] resume enrollment failed:', err);
      return error.internal(c, 'Failed to resume enrollment');
    }
  },
);

export const sequencesRoutes = app;

// ============================================================================
// /customer-sequences/:customerId — list every sequence a customer is
// enrolled in. Mounted at `/api/customer-sequences/*` in src/index.ts.
// ============================================================================

const customerSequencesApp = new Hono<{ Bindings: Env; Variables: Variables }>();

customerSequencesApp.get('/:customerId', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const customerId = c.req.param('customerId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 100);

  const conditions: any[] = [eq(e.customerId, customerId), isNull(w.deletedAt)];

  try {
    const rows = await db
      .select({
        enrollmentId: e.id,
        sequenceId: e.sequenceId,
        status: e.status,
        currentStepIndex: e.currentStepIndex,
        totalSteps: e.totalSteps,
        enrolledAt: e.enrolledAt,
        completedAt: e.completedAt,
        sequenceName: w.name,
        sequenceStatus: w.status,
      })
      .from(e)
      .innerJoin(w, eq(e.sequenceId, w.id))
      .where(and(...conditions))
      .orderBy(desc(e.enrolledAt))
      .limit(limit);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/customer-sequences] list failed:', err);
    return error.internal(c, 'Failed to list customer sequences');
  }
});

export const customerSequencesRoutes = customerSequencesApp;
