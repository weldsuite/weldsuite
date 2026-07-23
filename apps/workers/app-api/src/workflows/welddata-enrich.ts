/**
 * WelddataEnrichWorkflow — Cloudflare Workflow
 *
 * Background batch runner for WeldData enrichment columns. app-api creates one
 * instance per "run column" request; the workflow processes the target leads in
 * durable, retrying chunks. Each cell's action is resolved from the pluggable
 * registry (lib/enrichment/actions). The `ai` action is stubbed (AI has been
 * physically removed from WeldSuite — see lib/enrichment/actions/ai.ts) and
 * always returns an empty cell; other providers still call their own APIs.
 *
 * Hosted in app-api (the obsolete api-worker must not gain new code). Bound
 * locally in wrangler.toml as WELDDATA_ENRICH and exported from src/index.ts.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { getAction } from '../lib/enrichment/actions';
import type { ActionTenant } from '../lib/enrichment/actions/types';

export interface WelddataEnrichParams {
  workspaceId: string; // Clerk org id
  userId: string;
  listId: string;
  columnId: string;
  /** Explicit targets resolved by app-api. */
  leadIds: string[];
}

/** Leads per durable step. */
const CHUNK = 25;
/** Parallel action calls within a chunk. */
const CONCURRENCY = 5;

async function writeCell(
  db: Database,
  columnId: string,
  leadId: string,
  patch: {
    status: 'running' | 'done' | 'error';
    value?: string | null;
    data?: Record<string, unknown> | null;
    error?: string | null;
    creditsUsed?: number | null;
    ranAt?: Date | null;
  },
): Promise<void> {
  const { welddataCells } = schema;
  const now = new Date();
  await db
    .insert(welddataCells)
    .values({
      id: generateId('wdcell'),
      createdAt: now,
      updatedAt: now,
      columnId,
      leadId,
      status: patch.status,
      value: patch.value ?? null,
      data: patch.data ?? null,
      error: patch.error ?? null,
      creditsUsed: patch.creditsUsed ?? null,
      ranAt: patch.ranAt ?? null,
    })
    .onConflictDoUpdate({
      target: [welddataCells.columnId, welddataCells.leadId],
      set: {
        status: patch.status,
        value: patch.value ?? null,
        data: patch.data ?? null,
        error: patch.error ?? null,
        creditsUsed: patch.creditsUsed ?? null,
        ranAt: patch.ranAt ?? null,
        updatedAt: now,
      },
    });
}

async function buildSiblingValues(
  db: Database,
  listId: string,
  columnId: string,
  leadId: string,
): Promise<Record<string, string>> {
  const { welddataColumns, welddataCells } = schema;
  const cols = await db
    .select({ id: welddataColumns.id, name: welddataColumns.name })
    .from(welddataColumns)
    .where(
      and(
        eq(welddataColumns.listId, listId),
        ne(welddataColumns.id, columnId),
        isNull(welddataColumns.deletedAt),
      ),
    );
  if (cols.length === 0) return {};
  const nameById = new Map(cols.map((c) => [c.id, c.name]));
  const cells = await db
    .select({ columnId: welddataCells.columnId, value: welddataCells.value })
    .from(welddataCells)
    .where(
      and(
        inArray(welddataCells.columnId, cols.map((c) => c.id)),
        eq(welddataCells.leadId, leadId),
        eq(welddataCells.status, 'done'),
      ),
    );
  const out: Record<string, string> = {};
  for (const cell of cells) {
    const name = nameById.get(cell.columnId);
    if (name && cell.value) out[name.toLowerCase()] = cell.value;
  }
  return out;
}

export class WelddataEnrichWorkflow extends WorkflowEntrypoint<Env, WelddataEnrichParams> {
  async run(event: WorkflowEvent<WelddataEnrichParams>, step: WorkflowStep) {
    const { workspaceId, userId, listId, columnId, leadIds } = event.payload;
    const tenant: ActionTenant = { workspaceId, userId };
    const db = await getTenantDbForWorkspace(this.env, workspaceId);

    // Loaded inline (not a durable step): the read is cheap + idempotent, and
    // returning the jsonb `config` through a step.do boundary fails Cloudflare's
    // Serializable constraint. The durable work is the per-chunk steps below.
    const { welddataColumns } = schema;
    const [column] = await db
      .select({
        id: welddataColumns.id,
        listId: welddataColumns.listId,
        name: welddataColumns.name,
        type: welddataColumns.type,
        config: welddataColumns.config,
      })
      .from(welddataColumns)
      .where(
        and(
          eq(welddataColumns.id, columnId),
          eq(welddataColumns.listId, listId),
          isNull(welddataColumns.deletedAt),
        ),
      )
      .limit(1);
    if (!column) return;

    const action = getAction(column.type);

    // Once the workspace runs out of credits, short-circuit the rest of the run
    // — every remaining cell would just fail the same way (no spend happens, as
    // the credit check blocks before any model call).
    let outOfCredits = false;
    const INSUFFICIENT_CREDITS = 'Insufficient credits — add credits to continue enriching.';

    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const chunk = leadIds.slice(i, i + CHUNK);
      await step.do(
        `chunk-${i / CHUNK}`,
        { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } },
        async () => {
          const { welddataLeads } = schema;
          for (let j = 0; j < chunk.length; j += CONCURRENCY) {
            const batch = chunk.slice(j, j + CONCURRENCY);
            await Promise.all(
              batch.map(async (leadId) => {
                if (outOfCredits) {
                  await writeCell(db, columnId, leadId, {
                    status: 'error',
                    error: INSUFFICIENT_CREDITS,
                    ranAt: new Date(),
                  }).catch(() => {});
                  return;
                }
                try {
                  const [lead] = await db
                    .select()
                    .from(welddataLeads)
                    .where(and(eq(welddataLeads.id, leadId), isNull(welddataLeads.deletedAt)))
                    .limit(1);
                  if (!lead) return;
                  if (!action) {
                    await writeCell(db, columnId, leadId, {
                      status: 'error',
                      error: `Unknown action type: ${column.type}`,
                      ranAt: new Date(),
                    });
                    return;
                  }
                  await writeCell(db, columnId, leadId, { status: 'running' });
                  const siblingValues = await buildSiblingValues(db, listId, columnId, leadId);
                  const result = await action.run({
                    env: this.env,
                    db,
                    tenant,
                    column,
                    lead,
                    siblingValues,
                  });
                  await writeCell(db, columnId, leadId, {
                    status: 'done',
                    value: result.value,
                    data: result.data ?? null,
                    creditsUsed: result.creditsUsed ?? null,
                    error: null,
                    ranAt: new Date(),
                  });
                } catch (err) {
                  // Out of credits: latch the flag so the remaining leads (this
                  // run) short-circuit instead of each making a doomed call.
                  if ((err as { code?: string })?.code === 'insufficient_credits') {
                    outOfCredits = true;
                  }
                  const message = err instanceof Error ? err.message : 'Enrichment failed';
                  await writeCell(db, columnId, leadId, {
                    status: 'error',
                    error: message,
                    ranAt: new Date(),
                  }).catch(() => {});
                }
              }),
            );
          }
        },
      );
    }
  }
}
