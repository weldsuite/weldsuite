/**
 * Opportunities (deals) service — pipeline/stage logic for `crm_opportunities`.
 *
 * Pure business logic; no Hono context. Shared by the crm-api opportunities
 * routes and WeldConnect's `create_deal` / `move_deal_stage` workflow
 * actions, so every path inserts/updates the same row shape, keeps
 * won/lost/probability in step with the stage the same way, and publishes
 * identical `opportunity:*` event payloads.
 */

import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { CreateOpportunityInput } from '@weldsuite/core-api-client/schemas/opportunities';
import type { DataFor } from '@weldsuite/entity-events';

type OpportunityEventData = DataFor<'opportunity'>;

export type OpportunityRow = typeof schema.crmOpportunities.$inferSelect;
type OpportunityInsert = typeof schema.crmOpportunities.$inferInsert;

const NUMERIC_FIELDS = new Set(['amount', 'expectedRevenue', 'recurringRevenue']);
const DATE_FIELDS = new Set(['closeDate', 'startDate', 'nextStepDate']);

/**
 * `customerName` is a denormalized mirror of the company's name, kept so
 * list/search views don't need a join. Look the name up by `customerId` so
 * writers don't have to carry it themselves.
 */
export async function lookupCompanyName(
  db: Database,
  customerId: string | undefined,
): Promise<string | undefined> {
  if (!customerId) return undefined;
  const [row] = await db
    .select({ name: schema.companies.name })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, customerId), isNull(schema.companies.deletedAt)))
    .limit(1);
  return row?.name;
}

export interface CreateOpportunityResult {
  id: string;
  row: OpportunityInsert;
  eventData: OpportunityEventData;
}

/**
 * Insert an opportunity row. `ownerId` defaults to `actingUserId` when the
 * input doesn't specify one.
 */
export async function createOpportunity(
  db: Database,
  input: CreateOpportunityInput,
  actingUserId?: string,
): Promise<CreateOpportunityResult> {
  const { crmOpportunities: t } = schema;
  const ownerId = input.ownerId ?? actingUserId;
  if (!ownerId) throw new Error('ownerId required');
  const id = generateId('opp');
  const now = new Date();
  const closeDate = input.closeDate ? new Date(input.closeDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const customerName = await lookupCompanyName(db, input.customerId);
  const values: OpportunityInsert = {
    id,
    name: input.name,
    description: input.description,
    customerId: input.customerId,
    customerName,
    primaryContactId: input.primaryContactId,
    amount: input.amount !== undefined ? String(input.amount) : '0',
    currency: input.currency ?? 'EUR',
    expectedRevenue: input.expectedRevenue !== undefined ? String(input.expectedRevenue) : undefined,
    recurringRevenue: input.recurringRevenue !== undefined ? String(input.recurringRevenue) : undefined,
    contractLength: input.contractLength,
    stage: input.stage ?? 'prospecting',
    stageId: input.stageId,
    status: input.status ?? 'open',
    probability: input.probability ?? 0,
    pipeline: input.pipeline ?? 'default',
    closeDate,
    startDate: input.startDate ? new Date(input.startDate) : undefined,
    ownerId,
    teamMembers: input.teamMembers,
    leadSource: input.leadSource,
    campaign: input.campaign,
    type: input.type,
    category: input.category,
    nextStep: input.nextStep,
    nextStepDate: input.nextStepDate ? new Date(input.nextStepDate) : undefined,
    riskLevel: input.riskLevel,
    riskReason: input.riskReason,
    proposalUrl: input.proposalUrl,
    contractUrl: input.contractUrl,
    tags: input.tags,
    customFields: input.customFields as Record<string, unknown> | null | undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(t).values(values);
  const eventData: OpportunityEventData = {
    id,
    name: values.name,
    amount: values.amount ?? '0',
    stage: values.stage ?? 'prospecting',
    status: values.status ?? 'open',
    currency: values.currency,
    customerId: values.customerId,
    pipelineId: values.pipeline,
    ownerId: values.ownerId,
  };
  return { id, row: values, eventData };
}

/** Coerce one PATCH field to its column representation (numerics as strings, dates as Date). */
export function toColumnValue(key: string, value: unknown): unknown {
  if (NUMERIC_FIELDS.has(key) && typeof value === 'number') return String(value);
  if (DATE_FIELDS.has(key) && typeof value === 'string') return new Date(value);
  return value;
}

/** Build the `set` payload for a PATCH, skipping undefined fields. */
export function buildUpdatePayload(data: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) update[k] = toColumnValue(k, v);
  }
  return update;
}

export interface OpportunityUpdateEvent {
  action: 'updated' | 'stage_changed' | 'won' | 'lost';
  /**
   * Carries `stageId` too (consumers that need it, e.g. the WeldConnect
   * `move_deal_stage` result, read it off directly) — a superset of
   * `OpportunityEventData`, assignable to it since extra properties are
   * fine for a non-literal value.
   */
  data: OpportunityEventData & { stageId: string | null };
}

/**
 * The `updated` event plus the derived `stage_changed` / `won` / `lost`
 * events for a PATCH, comparing the new values against the pre-update row.
 * Pure — callers publish each entry themselves (crm-api via
 * `publishEntityEvent`, WeldConnect via `publishEntityEventRaw`).
 */
export function opportunityUpdateEvents(
  id: string,
  existing: OpportunityRow,
  update: Record<string, unknown>,
): OpportunityUpdateEvent[] {
  const newStage = (update.stage as string | undefined) ?? existing.stage;
  const newStageId = (update.stageId as string | null | undefined) ?? existing.stageId;
  const newStatus = (update.status as string | undefined) ?? existing.status;
  const eventData = {
    id,
    name: (update.name as string | undefined) ?? existing.name,
    amount: (update.amount as string | undefined) ?? existing.amount ?? '0',
    stage: newStage,
    stageId: newStageId,
    status: newStatus,
    customerId: (update.customerId as string | null | undefined) ?? existing.customerId,
    ownerId: (update.ownerId as string | null | undefined) ?? existing.ownerId,
  };

  const events: OpportunityUpdateEvent[] = [{ action: 'updated', data: eventData }];
  if (newStage !== existing.stage || newStageId !== existing.stageId) {
    events.push({ action: 'stage_changed', data: eventData });
  }
  if (newStatus === 'won' && existing.status !== 'won') {
    events.push({ action: 'won', data: eventData });
  } else if (newStatus === 'lost' && existing.status !== 'lost') {
    events.push({ action: 'lost', data: eventData });
  }
  return events;
}

export interface PipelineStageFlags {
  id: string;
  isWon: boolean | null;
  isLost: boolean | null;
  probability: number | null;
}

export async function loadStage(db: Database, stageId: string): Promise<PipelineStageFlags | undefined> {
  const [row] = await db
    .select({
      id: schema.crmPipelineStages.id,
      isWon: schema.crmPipelineStages.isWon,
      isLost: schema.crmPipelineStages.isLost,
      probability: schema.crmPipelineStages.probability,
    })
    .from(schema.crmPipelineStages)
    .where(and(eq(schema.crmPipelineStages.id, stageId), isNull(schema.crmPipelineStages.deletedAt)))
    .limit(1);
  return row;
}

/**
 * Keep `status` / `actualCloseDate` / `probability` in step with the stage a
 * deal sits in, in both directions (TASK-919):
 *  - Dragging the deal onto a stage flagged isWon/isLost (an explicit
 *    `stageId` in this PATCH) marks it won/lost, stamps `actualCloseDate`
 *    (today, unless already set) and copies the stage's probability. Moving
 *    it back out to a plain open stage reopens it and clears
 *    `actualCloseDate`.
 *  - Marking the deal won/lost directly (`status` in this PATCH, no
 *    `stageId`) moves it into the pipeline's matching isWon/isLost stage, if
 *    one exists, and stamps `actualCloseDate`. Reopening it directly clears
 *    `actualCloseDate`.
 * Mutates `update` in place; `targetStage` is the already-validated stage
 * for an explicit `stageId` move (avoids re-querying it).
 */
export async function syncStatusWithStage(
  db: Database,
  existing: OpportunityRow,
  data: Record<string, unknown>,
  update: Record<string, unknown>,
  targetStage: PipelineStageFlags | undefined,
): Promise<void> {
  const explicitStatus = typeof data.status === 'string' ? data.status : undefined;

  if (targetStage) {
    if (targetStage.isWon || targetStage.isLost) {
      if (update.status === undefined) update.status = targetStage.isWon ? 'won' : 'lost';
      if (update.actualCloseDate === undefined && !existing.actualCloseDate) update.actualCloseDate = new Date();
      if (update.probability === undefined && targetStage.probability !== null) {
        update.probability = targetStage.probability;
      }
    } else {
      const previousStage = existing.stageId ? await loadStage(db, existing.stageId) : undefined;
      if (previousStage && (previousStage.isWon || previousStage.isLost) && update.status === undefined) {
        update.status = 'open';
        update.actualCloseDate = null;
      }
    }
    return;
  }

  if (!explicitStatus || explicitStatus === existing.status) return;

  if (explicitStatus === 'won' || explicitStatus === 'lost') {
    if (update.actualCloseDate === undefined && !existing.actualCloseDate) update.actualCloseDate = new Date();
    if (update.stageId === undefined) {
      const pipeline = (update.pipeline as string | undefined) ?? existing.pipeline ?? 'default';
      const flagColumn =
        explicitStatus === 'won' ? schema.crmPipelineStages.isWon : schema.crmPipelineStages.isLost;
      const [matchStage] = await db
        .select({ id: schema.crmPipelineStages.id, probability: schema.crmPipelineStages.probability })
        .from(schema.crmPipelineStages)
        .where(
          and(
            eq(schema.crmPipelineStages.pipeline, pipeline),
            eq(flagColumn, true),
            isNull(schema.crmPipelineStages.deletedAt),
          ),
        )
        .limit(1);
      if (matchStage) {
        update.stageId = matchStage.id;
        if (data.stage === undefined) update.stage = matchStage.id;
        if (update.probability === undefined && matchStage.probability !== null) {
          update.probability = matchStage.probability;
        }
      }
    }
  } else if (explicitStatus === 'open' || explicitStatus === 'abandoned') {
    if ((existing.status === 'won' || existing.status === 'lost') && update.actualCloseDate === undefined) {
      update.actualCloseDate = null;
    }
  }
}

export class UnknownPipelineStageError extends Error {
  constructor(stageId: string) {
    super(`Unknown pipeline stage ${stageId}`);
    this.name = 'UnknownPipelineStageError';
  }
}

export interface MoveOpportunityStageResult {
  row: OpportunityRow;
  events: OpportunityUpdateEvent[];
}

/**
 * Move a deal onto a different pipeline stage (the WeldConnect
 * `move_deal_stage` step; also usable by a dedicated "move stage" surface).
 * Keeps won/lost/probability in sync exactly like a PATCH that sets
 * `stageId` would. Returns null when the deal doesn't exist (or is out of
 * `ownerScope`); throws `UnknownPipelineStageError` for an unknown stage.
 */
export async function moveOpportunityStage(
  db: Database,
  dealId: string,
  stageId: string,
  ownerScope?: string,
): Promise<MoveOpportunityStageResult | null> {
  const { crmOpportunities: t } = schema;
  const conditions: SQL[] = [eq(t.id, dealId), isNull(t.deletedAt)];
  if (ownerScope) conditions.push(eq(t.ownerId, ownerScope));
  const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  let targetStage: PipelineStageFlags | undefined;
  if (stageId !== existing.stageId) {
    targetStage = await loadStage(db, stageId);
    if (!targetStage) throw new UnknownPipelineStageError(stageId);
    update.stageId = stageId;
    update.stage = targetStage.id;
  }
  await syncStatusWithStage(db, existing, { stageId }, update, targetStage);
  await db.update(t).set(update).where(and(eq(t.id, dealId), isNull(t.deletedAt)));

  const row: OpportunityRow = { ...existing, ...update } as OpportunityRow;
  const events = opportunityUpdateEvents(dealId, existing, update);
  return { row, events };
}
