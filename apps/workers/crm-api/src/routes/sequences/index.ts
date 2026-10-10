/**
 * Sequences routes — flat /api/sequences/* surface backed by the `workflows`
 * table (rows tagged __type:sequence) plus `sequence_enrollments`.
 *
 * Workflow-engine actions (enroll-into-running, launch, pause/resume)
 * dispatch the EXECUTE_SEQUENCE Workflow, hosted in THIS worker (class in
 * @weldsuite/crm-domain/workflows/execute-sequence, names `execute-sequence-v3*`).
 *
 * Permissions reuse the `contacts` object (matches legacy api-worker behavior).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { SEQUENCE_RESUME_EVENT } from '@weldsuite/crm-domain/workflows/execute-sequence';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const w = schema.workflows;
const e = schema.sequenceEnrollments;
// Sequences enroll People directly (not the `parties` wrapper table — most
// people never get a wrapping party row, see packages/core/db/src/schema/
// parties.ts). `sequence_enrollments.customerId` stores a `people.id`.
const ppl = schema.people;

/**
 * Correlated per-sequence enrollment count. The outer `workflows.id` is
 * written out as a qualified identifier on purpose: in a single-table select
 * drizzle renders `${w.id}` as a bare `"id"`, which inside the subquery binds
 * to `sequence_enrollments.id`, so every count was 0 (TASK-942).
 */
function enrollmentCount(statusPredicate: SQL) {
  return sql<number>`(SELECT count(*)::int FROM sequence_enrollments WHERE sequence_enrollments.sequence_id = "workflows"."id" AND sequence_enrollments.status ${statusPredicate})`;
}

app.get('/', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 50, 100);

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
          enrolledCount: enrollmentCount(sql`!= 'unenrolled'`),
          activeEnrolledCount: enrollmentCount(sql`= 'active'`),
          pendingEnrolledCount: enrollmentCount(sql`= 'pending'`),
        })
        .from(w)
        .where(where)
        .orderBy(desc(w.createdAt), desc(w.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(w).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
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
        enrolledCount: enrollmentCount(sql`!= 'unenrolled'`),
        activeEnrolledCount: enrollmentCount(sql`= 'active'`),
        pendingEnrolledCount: enrollmentCount(sql`= 'pending'`),
        completedEnrolledCount: enrollmentCount(sql`= 'completed'`),
        failedEnrolledCount: enrollmentCount(sql`= 'failed'`),
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
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [eq(e.sequenceId, id), isNull(ppl.deletedAt)];
  if (q.status) conditions.push(eq(e.status, q.status));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(ppl.displayName, term), like(ppl.email, term))!);
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
    const [rows, countRes, sequenceRows] = await Promise.all([
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
          customerEmail: sql<string | null>`coalesce(${e.customerSnapshot}->>'email', ${ppl.email})`,
          customerFirstName: sql<string | null>`coalesce(${e.customerSnapshot}->>'firstName', ${ppl.firstName})`,
          customerLastName: sql<string | null>`coalesce(${e.customerSnapshot}->>'lastName', ${ppl.lastName})`,
          customerFullName: sql<string | null>`coalesce(${e.customerSnapshot}->>'fullName', ${ppl.displayName})`,
          customerCompanyName: sql<string | null>`${e.customerSnapshot}->>'companyName'`,
        })
        .from(e)
        .innerJoin(ppl, eq(e.customerId, ppl.id))
        .where(where)
        .orderBy(desc(e.enrolledAt), desc(e.id))
        .limit(limit + 1),
      db
        .select({ count: sql<number>`count(*)` })
        .from(e)
        .innerJoin(ppl, eq(e.customerId, ppl.id))
        .where(and(...filterConditions)),
      db.select({ steps: w.steps }).from(w).where(eq(w.id, id)).limit(1),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // `sequence_enrollments.total_steps` was never filled in, so every row said
    // 0 steps and the People tab could not tell how far a person had got.
    // Report the sequence's own step count instead.
    const stepCount = Array.isArray(sequenceRows[0]?.steps) ? sequenceRows[0].steps.length : 0;
    const data = page.map((row) => ({ ...row, totalSteps: stepCount > 0 ? stepCount : (row.totalSteps ?? 0) }));
    const nextCursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/sequences] list enrollments failed:', err);
    return error.internal(c, 'Failed to list enrollments');
  }
});

/**
 * DELETE /sequences/enrollments/:enrollmentId — mark an enrollment as
 * `unenrolled`. A running workflow checks the enrollment before every step
 * (readRunGate) and ends its run when it sees the status flip; a run parked on
 * a pause is woken so it notices right away.
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
    if (existing.status === 'paused' && existing.executionId) await wakeRuns(c, [existing.executionId]);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/sequences] unenroll failed:', err);
    return error.internal(c, 'Failed to unenroll');
  }
});

// The unenroll body (unenrollFromSequenceSchema) carries a reason the client
// sends for logging; it will be validated here once the audit-events binding
// is added to app-api.

// ============================================================================
// Workflow-engine actions — enroll, launch, start, pause/resume sequence,
// pause/resume enrollment. App-api owns the DB writes; the durable execution
// runs in the self-hosted EXECUTE_SEQUENCE workflow (execute-sequence-v3*)
// configured in wrangler.toml.
// ============================================================================

type TenantDb = Variables['tenantDb'];

/** Run `fn` over `items` with at most `limit` calls in flight (results keep the input order). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Workflow instances created / woken at once; keeps a bulk enroll from fanning out unbounded. */
const WORKFLOW_CALL_CONCURRENCY = 10;
/** Enrollment ids per UPDATE ... WHERE id IN (...). */
const ENROLLMENT_ID_CHUNK = 200;

interface SequenceRunContext {
  workspaceId: string;
  userId: string;
  sequenceId: string;
}

/**
 * Start EXECUTE_SEQUENCE for the given enrollments, at most once each.
 *
 * The Workflow instance id is the enrollment id (deterministic, <= 30 chars so
 * it fits `sequence_enrollments.execution_id` varchar(30); a Cloudflare-minted
 * UUID is 36 chars and overflowed the column, 500-ing launch/start AFTER the
 * workflow had already run, see TASK-941). Because it is deterministic, the
 * Workflows runtime itself also rejects a second instance for the same
 * enrollment.
 *
 * The ids are CLAIMED in the DB before any workflow is created: one
 * conditional `UPDATE ... WHERE execution_id IS NULL` per chunk that only one
 * caller can win per row, so a retry / concurrent launch / double click can
 * never trigger a second run (and a second round of emails) for the same
 * enrollment. The claimed instances are then created concurrently (bounded),
 * not one after the other: enrolling a page of people used to cost one UPDATE
 * plus one Workflows round trip per person, in sequence. If a create fails for
 * real, its claim is released so a later `start` can retry.
 *
 * Never throws: a failed trigger must not abort the batch; the enrollment row
 * stays in the DB and `start` retries it. Returns how many runs were started.
 */
async function startEnrollmentRuns(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  db: TenantDb,
  ctx: SequenceRunContext,
  enrollments: ReadonlyArray<{ id: string; customerId: string }>,
): Promise<number> {
  if (enrollments.length === 0) return 0;
  const binding = c.env.EXECUTE_SEQUENCE;
  if (!binding) {
    console.warn('[crm-api/sequences] EXECUTE_SEQUENCE binding missing, skipping workflow trigger');
    return 0;
  }

  const customerByEnrollment = new Map(enrollments.map((row) => [row.id, row.customerId]));
  const claimedIds: string[] = [];
  for (const ids of chunk(enrollments.map((row) => row.id), ENROLLMENT_ID_CHUNK)) {
    try {
      const claimed = await db
        .update(e)
        // instance id === enrollment id
        .set({ executionId: sql`${e.id}` })
        .where(and(inArray(e.id, ids), eq(e.status, 'active'), isNull(e.executionId)))
        .returning({ id: e.id });
      claimedIds.push(...claimed.map((row) => row.id));
    } catch (err) {
      console.error('[crm-api/sequences] failed to claim enrollment runs:', err);
    }
  }

  const outcomes = await mapWithConcurrency(claimedIds, WORKFLOW_CALL_CONCURRENCY, async (instanceId) => {
    try {
      await binding.create({
        id: instanceId,
        params: { ...ctx, enrollmentId: instanceId, customerId: customerByEnrollment.get(instanceId)! },
      });
      return 'triggered' as const;
    } catch (err) {
      // The instance may already exist (a previous attempt created it but the
      // worker died before responding): then the run is real, keep the claim.
      try {
        await binding.get(instanceId);
        return 'exists' as const;
      } catch {
        // not found: the create genuinely failed
      }
      console.error('[crm-api/sequences] EXECUTE_SEQUENCE.create failed:', err);
      return 'failed' as const;
    }
  });

  const failedIds = claimedIds.filter((_, index) => outcomes[index] === 'failed');
  for (const ids of chunk(failedIds, ENROLLMENT_ID_CHUNK)) {
    try {
      await db
        .update(e)
        .set({ executionId: null })
        .where(and(inArray(e.id, ids), sql`${e.executionId} = ${e.id}`));
    } catch (releaseErr) {
      console.error('[crm-api/sequences] failed to release enrollment claims:', releaseErr);
    }
  }

  return outcomes.filter((outcome) => outcome === 'triggered').length;
}

/**
 * Wake workflow runs that may be parked on a pause (or must notice an
 * unenroll) so they re-read the database now instead of at their next daily
 * re-check. Best effort and only a hint: an instance that is not parked, has
 * finished, or does not exist just ignores or rejects the event.
 */
async function wakeRuns(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  executionIds: readonly string[],
): Promise<void> {
  const binding = c.env.EXECUTE_SEQUENCE;
  if (!binding || executionIds.length === 0) return;
  const results = await mapWithConcurrency(executionIds, WORKFLOW_CALL_CONCURRENCY, async (instanceId) => {
    try {
      const instance = await binding.get(instanceId);
      await instance.sendEvent({ type: SEQUENCE_RESUME_EVENT, payload: {} });
      return true;
    } catch {
      return false;
    }
  });
  const missed = results.filter((delivered) => !delivered).length;
  if (missed > 0) {
    console.warn(`[crm-api/sequences] resume event not delivered to ${missed} of ${executionIds.length} runs`);
  }
}

/**
 * Start a run for every active enrollment of a sequence that has none yet.
 * Returns how many runs were started.
 */
async function startPendingRuns(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  db: TenantDb,
  ctx: SequenceRunContext,
): Promise<number> {
  const rows = await db
    .select({ id: e.id, customerId: e.customerId })
    .from(e)
    .where(and(eq(e.sequenceId, ctx.sequenceId), eq(e.status, 'active'), isNull(e.executionId)));
  return startEnrollmentRuns(c, db, ctx, rows);
}

/**
 * Flip a sequence to `active`, turn every `pending` enrollment `active` (a
 * conditional UPDATE ... RETURNING, so concurrent callers split the rows
 * instead of both seeing them) and start a run for every active enrollment
 * that has none. Shared by `launch` and `resume`.
 *
 * With `resumePaused` (resume only) it also turns every `paused` enrollment
 * `active` again and wakes its parked run, so a Pause followed by a Resume
 * continues each person where they left off. `launch` leaves paused
 * enrollments alone: it can be re-sent to a running sequence, and must not
 * un-pause a person someone paused on purpose.
 *
 * Returns how many pending enrollments were activated and how many paused
 * ones were resumed.
 */
async function activateSequence(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  db: TenantDb,
  ctx: SequenceRunContext,
  options: { resumePaused: boolean },
): Promise<{ activated: number; resumed: number }> {
  await db
    .update(w)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(w.id, ctx.sequenceId));

  const activated = await db
    .update(e)
    .set({ status: 'active' })
    .where(and(eq(e.sequenceId, ctx.sequenceId), eq(e.status, 'pending')))
    .returning({ id: e.id });

  let resumed: Array<{ id: string; executionId: string | null }> = [];
  if (options.resumePaused) {
    resumed = await db
      .update(e)
      .set({ status: 'active', pausedAt: null })
      .where(and(eq(e.sequenceId, ctx.sequenceId), eq(e.status, 'paused')))
      .returning({ id: e.id, executionId: e.executionId });
    await wakeRuns(c, resumed.flatMap((row) => (row.executionId ? [row.executionId] : [])));
  }

  await startPendingRuns(c, db, ctx);
  return { activated: activated.length, resumed: resumed.length };
}

// `personIds` is the current field — sequences enroll People directly.
// `customerIds` is kept accepted for any caller still sending the pre-refactor
// name (the WeldCRM dialog itself now sends `personIds`); at least one of the
// two must be present.
const enrollSchema = z
  .object({
    personIds: z.array(z.string()).min(1).optional(),
    customerIds: z.array(z.string()).min(1).optional(),
  })
  .refine((data) => (data.personIds?.length ?? 0) > 0 || (data.customerIds?.length ?? 0) > 0, {
    message: 'personIds (or customerIds) must include at least one id',
  });

/**
 * POST /sequences/:id/enroll — bulk-enroll people. Each new row starts as
 * `pending` if the sequence is still a draft, or `active` (and triggers the
 * workflow immediately) if the sequence is already running. The
 * `(sequenceId, customerId)` unique constraint makes the call idempotent —
 * re-enrolling an existing person no-ops without erroring. If none of the
 * given ids resolve to a live person row, the call fails loudly (400) rather
 * than silently reporting `enrolled: 0`.
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
    const { personIds, customerIds } = c.req.valid('json');

    try {
      const ids = Array.from(new Set([...(personIds ?? []), ...(customerIds ?? [])]));

      // Everything the insert needs is looked up in ONE round trip: the four
      // reads only depend on the requested ids, so they run side by side
      // instead of one after the other (enrolling took ~5 s with them chained).
      const [sequenceRows, people, employments, alreadyEnrolled] = await Promise.all([
        db
          .select({ id: w.id, status: w.status, steps: w.steps })
          .from(w)
          .where(and(eq(w.id, sequenceId), isNull(w.deletedAt)))
          .limit(1),
        db
          .select({
            id: ppl.id,
            displayName: ppl.displayName,
            email: ppl.email,
            firstName: ppl.firstName,
            lastName: ppl.lastName,
            fullName: ppl.fullName,
            directPhone: ppl.directPhone,
            mobilePhone: ppl.mobilePhone,
            primaryAddress: ppl.primaryAddress,
          })
          .from(ppl)
          .where(and(inArray(ppl.id, ids), isNull(ppl.deletedAt))),
        // Primary employer name, when any — used for the `{{contact.companyName}}`
        // template variable. A person without a company just omits it.
        db
          .select({
            personId: schema.personCompanies.personId,
            companyName: schema.companies.displayName,
          })
          .from(schema.personCompanies)
          .innerJoin(schema.companies, eq(schema.personCompanies.companyId, schema.companies.id))
          .where(
            and(
              inArray(schema.personCompanies.personId, ids),
              eq(schema.personCompanies.isPrimary, true),
              isNull(schema.personCompanies.endedAt),
            ),
          ),
        db
          .select({ customerId: e.customerId })
          .from(e)
          .where(and(eq(e.sequenceId, sequenceId), inArray(e.customerId, ids))),
      ]);

      const [sequence] = sequenceRows;
      if (!sequence) return error.notFound(c, 'Sequence', sequenceId);

      const isActiveSequence = sequence.status === 'active';
      const totalSteps = Array.isArray(sequence.steps) ? sequence.steps.length : 0;

      const personById = new Map(people.map((row) => [row.id, row]));
      const knownIds = ids.filter((id) => personById.has(id));
      if (knownIds.length === 0) {
        return error.badRequest(c, 'No matching people found to enroll', { ids });
      }

      const companyNameByPersonId = new Map<string, string>();
      for (const row of employments) {
        if (row.companyName) companyNameByPersonId.set(row.personId, row.companyName);
      }

      const enrolledSet = new Set(alreadyEnrolled.map((r) => r.customerId));
      const toEnroll = knownIds.filter((id) => !enrolledSet.has(id));
      if (toEnroll.length === 0) {
        return success(c, { enrolled: 0, enrollmentIds: [] });
      }

      const now = new Date();
      const enrollmentRows = toEnroll.map((customerId) => {
        const person = personById.get(customerId)!;
        const primaryAddress = person.primaryAddress as { city?: string; country?: string } | null;
        return {
          id: generateId('senr'),
          sequenceId,
          customerId,
          counterpartyId: customerId,
          status: isActiveSequence ? 'active' : 'pending',
          totalSteps,
          enrolledBy: userId,
          enrolledAt: now,
          customerSnapshot: {
            email: person.email ?? undefined,
            firstName: person.firstName ?? undefined,
            lastName: person.lastName ?? undefined,
            fullName: person.fullName ?? person.displayName ?? undefined,
            companyName: companyNameByPersonId.get(customerId),
            phone: person.directPhone ?? person.mobilePhone ?? undefined,
            city: primaryAddress?.city,
            country: primaryAddress?.country,
          },
        };
      });

      // One multi-row INSERT. A concurrent enroll of the same person loses to
      // the (sequence, person) unique index instead of failing the whole call.
      const inserted = await db
        .insert(e)
        .values(enrollmentRows)
        .onConflictDoNothing({ target: [e.sequenceId, e.customerId] })
        .returning({ id: e.id, customerId: e.customerId });

      if (isActiveSequence) {
        await startEnrollmentRuns(c, db, { workspaceId, userId, sequenceId }, inserted);
      }

      return success(c, {
        enrolled: inserted.length,
        enrollmentIds: inserted.map((r) => r.id),
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
 *
 * Enforces the same "launch checklist" the editor UI shows (at least one
 * step, at least one enrolled person). The Sequences list row's "Activate"
 * action calls this route (not the generic PATCH /workflows/:id/status,
 * which exempts `__type:sequence` workflows from its own WeldConnect-MVP
 * validation — see connect-api's `rejectUnsupportedActivation` — and so has
 * no equivalent check of its own) so both launch paths agree.
 */
app.post('/:id/launch', requirePermission('contacts:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const sequenceId = c.req.param('id');

  try {
    const [sequence] = await db
      .select({ id: w.id, status: w.status, steps: w.steps })
      .from(w)
      .where(and(eq(w.id, sequenceId), isNull(w.deletedAt)))
      .limit(1);
    if (!sequence) return error.notFound(c, 'Sequence', sequenceId);

    const stepCount = Array.isArray(sequence.steps) ? sequence.steps.length : 0;
    if (stepCount === 0) {
      return error.badRequest(c, 'Add at least one step before launching this sequence');
    }

    const [enrolledCountRes] = await db
      .select({ count: sql<number>`count(*)` })
      .from(e)
      .where(and(eq(e.sequenceId, sequenceId), sql`${e.status} != 'unenrolled'`));
    if (Number(enrolledCountRes?.count ?? 0) === 0) {
      return error.badRequest(c, 'Enroll at least one person before launching this sequence');
    }

    const { activated } = await activateSequence(c, db, { workspaceId, userId, sequenceId }, { resumePaused: false });

    publishEntityEvent({
      c,
      entityType: 'sequence',
      entityId: sequenceId,
      action: 'updated',
      data: { id: sequenceId, status: 'active' },
    });
    return success(c, { activated });
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

    const triggered = await startPendingRuns(c, db, { workspaceId, userId, sequenceId });

    return success(c, { triggered });
  } catch (err) {
    console.error('[app-api/sequences] start failed:', err);
    return error.internal(c, 'Failed to start sequence');
  }
});

/**
 * POST /sequences/:id/resume — set a paused sequence back to `active`, turn
 * its `paused` enrollments `active` again and wake their parked workflow runs
 * (they continue with the step after the one they stopped at), and start every
 * pending enrollment (plus any active enrollment that never got a run). Unlike
 * `launch` it has no checklist: a paused sequence already passed it once.
 * `start` alone cannot do this, it only re-triggers enrollments that are
 * already `active` and leaves the sequence paused (TASK-942).
 */
app.post('/:id/resume', requirePermission('contacts:update'), async (c) => {
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

    const { activated, resumed } = await activateSequence(
      c,
      db,
      { workspaceId, userId, sequenceId },
      { resumePaused: true },
    );

    publishEntityEvent({
      c,
      entityType: 'sequence',
      entityId: sequenceId,
      action: 'updated',
      data: { id: sequenceId, status: 'active' },
    });
    return success(c, { resumed: true, activated, resumedEnrollments: resumed });
  } catch (err) {
    console.error('[crm-api/sequences] resume sequence failed:', err);
    return error.internal(c, 'Failed to resume sequence');
  }
});

/**
 * POST /sequences/:id/pause — flip the sequence's workflow row to `paused` and
 * every `active` enrollment to `paused` (with `pausedAt`), so the People tab
 * shows the truth and the Pause actually holds.
 *
 * In-flight workflow runs are not cancelled: each one re-reads the sequence and
 * enrollment status before its next step (readRunGate in
 * @weldsuite/crm-domain/workflows/execute-sequence) and parks while either is
 * paused, so a run that is mid-delay does not send its next email when the
 * delay ends. Resume flips the rows back and wakes the parked runs.
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

    const now = new Date();
    await db
      .update(w)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(w.id, sequenceId));
    const paused = await db
      .update(e)
      .set({ status: 'paused', pausedAt: now })
      .where(and(eq(e.sequenceId, sequenceId), eq(e.status, 'active')))
      .returning({ id: e.id });
    publishEntityEvent({
      c,
      entityType: 'sequence',
      entityId: sequenceId,
      action: 'updated',
      data: { id: sequenceId, status: 'paused' },
    });
    return success(c, { paused: true, pausedEnrollments: paused.length });
  } catch (err) {
    console.error('[app-api/sequences] pause sequence failed:', err);
    return error.internal(c, 'Failed to pause sequence');
  }
});

/**
 * PATCH /sequences/:sequenceId/enrollments/:enrollmentId/pause — DB-only
 * status flip for an `active` enrollment. Its workflow run sees `paused` before
 * its next step and parks until the enrollment is resumed.
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
        .select({ id: e.id, status: e.status })
        .from(e)
        .where(and(eq(e.id, enrollmentId), eq(e.sequenceId, sequenceId)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Enrollment', enrollmentId);
      if (existing.status !== 'active') {
        return error.conflict(c, `Only an active enrollment can be paused (this one is ${existing.status})`);
      }

      await db
        .update(e)
        .set({ status: 'paused', pausedAt: new Date() })
        .where(and(eq(e.id, enrollmentId), eq(e.status, 'active')));
      return success(c, { paused: true });
    } catch (err) {
      console.error('[app-api/sequences] pause enrollment failed:', err);
      return error.internal(c, 'Failed to pause enrollment');
    }
  },
);

/**
 * PATCH /sequences/:sequenceId/enrollments/:enrollmentId/resume — clear the
 * paused flag, wake the enrollment's parked workflow run, or re-trigger
 * EXECUTE_SEQUENCE if it has no run yet. Refused while the whole sequence is
 * paused: the run would just park again, so the sequence is resumed first.
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
      const [[existing], [sequence]] = await Promise.all([
        db
          .select({
            id: e.id,
            customerId: e.customerId,
            status: e.status,
            executionId: e.executionId,
          })
          .from(e)
          .where(and(eq(e.id, enrollmentId), eq(e.sequenceId, sequenceId)))
          .limit(1),
        db.select({ status: w.status }).from(w).where(and(eq(w.id, sequenceId), isNull(w.deletedAt))).limit(1),
      ]);
      if (!existing || !sequence) return error.notFound(c, 'Enrollment', enrollmentId);
      if (existing.status !== 'paused') {
        return error.conflict(c, `Only a paused enrollment can be resumed (this one is ${existing.status})`);
      }
      if (sequence.status === 'paused') {
        return error.conflict(c, 'Resume the sequence before resuming a person');
      }

      await db
        .update(e)
        .set({ status: 'active', pausedAt: null })
        .where(and(eq(e.id, enrollmentId), eq(e.status, 'paused')));

      if (existing.executionId) {
        // The run is parked on the pause: wake it.
        await wakeRuns(c, [existing.executionId]);
      } else {
        // Never started (e.g. paused before its first run): start it now.
        await startEnrollmentRuns(c, db, { workspaceId, userId, sequenceId }, [
          { id: enrollmentId, customerId: existing.customerId },
        ]);
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
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 50, 100);

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
