/**
 * WeldAgent Grok-parity services — skills, routines, approvals, memory, templates, teach.
 */

import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { computeNextRunAt } from '@weldsuite/workflow-integrations/cron';
import type { AgentDb } from './agents';
import { getAgent, createAgent, updateAgent } from './agents';

function now() {
  return new Date();
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function serializeSkill(row: typeof schema.weldagentSkills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    status: row.status as 'draft' | 'active' | 'archived',
    steps: (row.steps ?? []) as Array<Record<string, unknown>>,
    createdBy: row.createdBy,
    sourceAgentId: row.sourceAgentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSkills(db: AgentDb, status?: string) {
  const conditions = [isNull(schema.weldagentSkills.deletedAt)];
  if (status) conditions.push(eq(schema.weldagentSkills.status, status));
  const rows = await db
    .select()
    .from(schema.weldagentSkills)
    .where(and(...conditions))
    .orderBy(desc(schema.weldagentSkills.updatedAt));
  return rows.map(serializeSkill);
}

export async function getSkill(db: AgentDb, id: string) {
  const [row] = await db
    .select()
    .from(schema.weldagentSkills)
    .where(and(eq(schema.weldagentSkills.id, id), isNull(schema.weldagentSkills.deletedAt)))
    .limit(1);
  return row ? serializeSkill(row) : null;
}

export async function createSkill(
  db: AgentDb,
  input: {
    name: string;
    description?: string | null;
    instructions: string;
    steps?: Array<Record<string, unknown>>;
    status?: 'draft' | 'active' | 'archived';
    createdBy?: string;
    sourceAgentId?: string;
  },
) {
  const id = generateId('skl');
  await db.insert(schema.weldagentSkills).values({
    id,
    name: input.name.trim(),
    description: input.description ?? null,
    instructions: input.instructions.trim(),
    steps: input.steps ?? [],
    status: input.status ?? 'draft',
    createdBy: input.createdBy ?? null,
    sourceAgentId: input.sourceAgentId ?? null,
  });
  return (await getSkill(db, id))!;
}

export async function updateSkill(
  db: AgentDb,
  id: string,
  input: Partial<{
    name: string;
    description: string | null;
    instructions: string;
    steps: Array<Record<string, unknown>>;
    status: 'draft' | 'active' | 'archived';
  }>,
) {
  const existing = await getSkill(db, id);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.instructions !== undefined) patch.instructions = input.instructions.trim();
  if (input.steps !== undefined) patch.steps = input.steps;
  if (input.status !== undefined) patch.status = input.status;
  await db.update(schema.weldagentSkills).set(patch).where(eq(schema.weldagentSkills.id, id));
  return getSkill(db, id);
}

export async function deleteSkill(db: AgentDb, id: string) {
  const existing = await getSkill(db, id);
  if (!existing) return false;
  await db
    .update(schema.weldagentSkills)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.weldagentSkills.id, id));
  return true;
}

export async function listAgentSkills(db: AgentDb, agentId: string) {
  const rows = await db
    .select({
      link: schema.weldagentAgentSkills,
      skill: schema.weldagentSkills,
    })
    .from(schema.weldagentAgentSkills)
    .innerJoin(
      schema.weldagentSkills,
      eq(schema.weldagentAgentSkills.skillId, schema.weldagentSkills.id),
    )
    .where(
      and(
        eq(schema.weldagentAgentSkills.agentId, agentId),
        isNull(schema.weldagentSkills.deletedAt),
      ),
    );
  return rows.map((r) => ({
    ...serializeSkill(r.skill),
    enabled: r.link.enabled,
    linkId: r.link.id,
  }));
}

export async function enableSkillForAgent(db: AgentDb, agentId: string, skillId: string) {
  const skill = await getSkill(db, skillId);
  if (!skill) return null;
  const [existing] = await db
    .select()
    .from(schema.weldagentAgentSkills)
    .where(
      and(
        eq(schema.weldagentAgentSkills.agentId, agentId),
        eq(schema.weldagentAgentSkills.skillId, skillId),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(schema.weldagentAgentSkills)
      .set({ enabled: true })
      .where(eq(schema.weldagentAgentSkills.id, existing.id));
    return skill;
  }
  await db.insert(schema.weldagentAgentSkills).values({
    id: generateId('asl'),
    agentId,
    skillId,
    enabled: true,
  });
  return skill;
}

export async function disableSkillForAgent(db: AgentDb, agentId: string, skillId: string) {
  await db
    .update(schema.weldagentAgentSkills)
    .set({ enabled: false })
    .where(
      and(
        eq(schema.weldagentAgentSkills.agentId, agentId),
        eq(schema.weldagentAgentSkills.skillId, skillId),
      ),
    );
  return true;
}

export async function skillsPromptBlock(db: AgentDb, agentId: string): Promise<string> {
  const skills = (await listAgentSkills(db, agentId)).filter((s) => s.enabled && s.status === 'active');
  if (skills.length === 0) return '';
  return (
    'Enabled skills (follow when relevant):\n' +
    skills
      .map((s) => `- ${s.name}: ${s.instructions.slice(0, 1500)}`)
      .join('\n')
  );
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

function serializeRoutine(row: typeof schema.weldagentRoutines.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    instructions: row.instructions,
    skillId: row.skillId,
    scheduleKind: row.scheduleKind as 'cron' | 'event' | 'connector',
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    eventKey: row.eventKey,
    connectorConfig: row.connectorConfig,
    enabled: row.enabled,
    requireApproval: row.requireApproval,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Top of the next UTC hour — fallback when a cron expression can't be parsed. */
export function computeNextHourlyRun(from = new Date()): Date {
  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * Next due time for a cron routine, honouring its expression + timezone. The
 * app-api sweep runs hourly, so a routine fires at the first sweep at or after
 * this instant.
 */
export function computeRoutineNextRun(
  cronExpr: string | null | undefined,
  timezone: string | null | undefined,
  from = new Date(),
): Date {
  const expr = cronExpr?.trim() || '0 * * * *';
  return computeNextRunAt(expr, timezone || 'UTC', from) ?? computeNextHourlyRun(from);
}

export async function listRoutines(db: AgentDb, agentId?: string) {
  const conditions = [isNull(schema.weldagentRoutines.deletedAt)];
  if (agentId) conditions.push(eq(schema.weldagentRoutines.agentId, agentId));
  const rows = await db
    .select()
    .from(schema.weldagentRoutines)
    .where(and(...conditions))
    .orderBy(desc(schema.weldagentRoutines.updatedAt));
  return rows.map(serializeRoutine);
}

export async function getRoutine(db: AgentDb, id: string) {
  const [row] = await db
    .select()
    .from(schema.weldagentRoutines)
    .where(and(eq(schema.weldagentRoutines.id, id), isNull(schema.weldagentRoutines.deletedAt)))
    .limit(1);
  return row ? serializeRoutine(row) : null;
}

export async function createRoutine(
  db: AgentDb,
  input: {
    agentId: string;
    name: string;
    instructions: string;
    skillId?: string | null;
    scheduleKind?: 'cron' | 'event' | 'connector';
    cronExpr?: string | null;
    timezone?: string;
    eventKey?: string | null;
    connectorConfig?: typeof schema.weldagentRoutines.$inferInsert['connectorConfig'];
    enabled?: boolean;
    requireApproval?: boolean;
    createdBy?: string;
  },
) {
  const id = generateId('rtn');
  const scheduleKind = input.scheduleKind ?? 'cron';
  const cronExpr = input.cronExpr ?? (scheduleKind === 'cron' ? '0 * * * *' : null);
  const timezone = input.timezone ?? 'UTC';
  const nextRunAt = scheduleKind === 'cron' ? computeRoutineNextRun(cronExpr, timezone) : null;
  await db.insert(schema.weldagentRoutines).values({
    id,
    agentId: input.agentId,
    name: input.name.trim(),
    instructions: input.instructions.trim(),
    skillId: input.skillId ?? null,
    scheduleKind,
    cronExpr,
    timezone,
    eventKey: input.eventKey ?? null,
    connectorConfig: input.connectorConfig ?? null,
    enabled: input.enabled ?? true,
    requireApproval: input.requireApproval ?? false,
    nextRunAt,
    createdBy: input.createdBy ?? null,
  });
  return (await getRoutine(db, id))!;
}

export async function updateRoutine(
  db: AgentDb,
  id: string,
  input: Partial<{
    name: string;
    instructions: string;
    skillId: string | null;
    scheduleKind: 'cron' | 'event' | 'connector';
    cronExpr: string | null;
    timezone: string;
    eventKey: string | null;
    connectorConfig: typeof schema.weldagentRoutines.$inferInsert['connectorConfig'];
    enabled: boolean;
    requireApproval: boolean;
  }>,
) {
  const existing = await getRoutine(db, id);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: now() };
  for (const key of [
    'name',
    'instructions',
    'skillId',
    'scheduleKind',
    'cronExpr',
    'timezone',
    'eventKey',
    'connectorConfig',
    'enabled',
    'requireApproval',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  const scheduleKind = input.scheduleKind ?? existing.scheduleKind;
  const scheduleChanged =
    input.enabled === true ||
    input.scheduleKind !== undefined ||
    input.cronExpr !== undefined ||
    input.timezone !== undefined;
  if (scheduleKind === 'cron' && scheduleChanged) {
    patch.nextRunAt = computeRoutineNextRun(
      input.cronExpr !== undefined ? input.cronExpr : existing.cronExpr,
      input.timezone ?? existing.timezone,
    );
  } else if (scheduleKind !== 'cron' && input.scheduleKind !== undefined) {
    patch.nextRunAt = null;
  }
  await db.update(schema.weldagentRoutines).set(patch).where(eq(schema.weldagentRoutines.id, id));
  return getRoutine(db, id);
}

export async function deleteRoutine(db: AgentDb, id: string) {
  const existing = await getRoutine(db, id);
  if (!existing) return false;
  await db
    .update(schema.weldagentRoutines)
    .set({ deletedAt: now(), updatedAt: now(), enabled: false })
    .where(eq(schema.weldagentRoutines.id, id));
  return true;
}

export async function listRoutineRuns(db: AgentDb, routineId: string, limit = 20) {
  const rows = await db
    .select()
    .from(schema.weldagentRoutineRuns)
    .where(eq(schema.weldagentRoutineRuns.routineId, routineId))
    .orderBy(desc(schema.weldagentRoutineRuns.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    routineId: r.routineId,
    agentId: r.agentId,
    status: r.status,
    trigger: r.trigger,
    summary: r.summary,
    error: r.error,
    agentRunId: r.agentRunId,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createRoutineRun(
  db: AgentDb,
  input: { routineId: string; agentId: string; trigger: string },
) {
  const id = generateId('rrn');
  await db.insert(schema.weldagentRoutineRuns).values({
    id,
    routineId: input.routineId,
    agentId: input.agentId,
    status: 'queued',
    trigger: input.trigger,
    startedAt: now(),
  });
  return id;
}

export async function completeRoutineRun(
  db: AgentDb,
  runId: string,
  input: { status: string; summary?: string; error?: string; agentRunId?: string },
) {
  await db
    .update(schema.weldagentRoutineRuns)
    .set({
      status: input.status,
      summary: input.summary ?? null,
      error: input.error ?? null,
      agentRunId: input.agentRunId ?? null,
      completedAt: now(),
    })
    .where(eq(schema.weldagentRoutineRuns.id, runId));
}

/**
 * Enabled cron routines whose `next_run_at` has passed. Routines of paused,
 * draft or deleted agents are skipped — pausing an agent pauses its schedule.
 */
export async function listDueCronRoutines(db: AgentDb, asOf = new Date()) {
  const { weldagentRoutines: r, weldagentAgents: a } = schema;
  const rows = await db
    .select({ routine: r })
    .from(r)
    .innerJoin(a, eq(a.id, r.agentId))
    .where(
      and(
        eq(r.enabled, true),
        eq(r.scheduleKind, 'cron'),
        isNull(r.deletedAt),
        lte(r.nextRunAt, asOf),
        eq(a.status, 'active'),
        isNull(a.deletedAt),
      ),
    )
    .limit(50);
  return rows.map((row) => serializeRoutine(row.routine));
}

/** Record a routine run; cron routines also advance past it. */
export async function markRoutineScheduled(
  db: AgentDb,
  routine: { id: string; cronExpr: string | null; timezone: string; scheduleKind?: string },
) {
  const isCron = (routine.scheduleKind ?? 'cron') === 'cron';
  await db
    .update(schema.weldagentRoutines)
    .set({
      lastRunAt: now(),
      ...(isCron ? { nextRunAt: computeRoutineNextRun(routine.cronExpr, routine.timezone) } : {}),
      updatedAt: now(),
    })
    .where(eq(schema.weldagentRoutines.id, routine.id));
}

/**
 * Atomically claim a due cron routine: advance `next_run_at` only if it is
 * still due. Overlapping sweeps can both list the same routine, but only one
 * claim succeeds, so each occurrence runs once.
 */
export async function claimDueRoutine(
  db: AgentDb,
  routine: { id: string; cronExpr: string | null; timezone: string },
  asOf = new Date(),
): Promise<boolean> {
  const { weldagentRoutines: r } = schema;
  const claimed = await db
    .update(r)
    .set({
      lastRunAt: now(),
      nextRunAt: computeRoutineNextRun(routine.cronExpr, routine.timezone, asOf),
      updatedAt: now(),
    })
    .where(and(eq(r.id, routine.id), lte(r.nextRunAt, asOf)))
    .returning({ id: r.id });
  return claimed.length > 0;
}

/** Give back a claimed occurrence that could not be started (retried next sweep). */
export async function releaseRoutineClaim(db: AgentDb, routineId: string, dueAt = new Date()) {
  await db
    .update(schema.weldagentRoutines)
    .set({ nextRunAt: dueAt, updatedAt: now() })
    .where(eq(schema.weldagentRoutines.id, routineId));
}

/** True when this routine already has a run for this trigger key (redelivery guard). */
export async function hasRoutineRunForTrigger(
  db: AgentDb,
  routineId: string,
  trigger: string,
): Promise<boolean> {
  const { weldagentRoutineRuns: rr } = schema;
  const [existing] = await db
    .select({ id: rr.id })
    .from(rr)
    .where(and(eq(rr.routineId, routineId), eq(rr.trigger, trigger)))
    .limit(1);
  return Boolean(existing);
}

/** Enabled event routines (of active agents) listening for `eventKey`. */
export async function findEventRoutines(db: AgentDb, eventKey: string) {
  const { weldagentRoutines: r, weldagentAgents: a } = schema;
  const rows = await db
    .select({ routine: r })
    .from(r)
    .innerJoin(a, eq(a.id, r.agentId))
    .where(
      and(
        eq(r.enabled, true),
        eq(r.scheduleKind, 'event'),
        eq(r.eventKey, eventKey),
        isNull(r.deletedAt),
        eq(a.status, 'active'),
        isNull(a.deletedAt),
      ),
    );
  return rows.map((row) => serializeRoutine(row.routine));
}

export async function findConnectorRoutines(
  db: AgentDb,
  input: { provider: 'slack' | 'github'; channel?: string; repo?: string; event?: string; text?: string },
) {
  const rows = await db
    .select()
    .from(schema.weldagentRoutines)
    .where(
      and(
        eq(schema.weldagentRoutines.enabled, true),
        eq(schema.weldagentRoutines.scheduleKind, 'connector'),
        isNull(schema.weldagentRoutines.deletedAt),
      ),
    );
  return rows
    .map(serializeRoutine)
    .filter((r) => {
      const cfg = r.connectorConfig;
      if (!cfg || cfg.provider !== input.provider) return false;
      if (cfg.channel && input.channel && cfg.channel !== input.channel) return false;
      if (cfg.repo && input.repo && cfg.repo !== input.repo) return false;
      if (cfg.event && input.event && cfg.event !== input.event) return false;
      if (cfg.match && input.text && !input.text.toLowerCase().includes(cfg.match.toLowerCase())) {
        return false;
      }
      return true;
    });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const HIGH_RISK_TOOLS = new Set([
  'computer_exec',
  'computer_write_file',
  'computer_run_code',
  'create_person',
  'create_ticket',
  'create_task',
  'message_agent',
  'create_agent_group_chat',
]);

/** browser_act actions that can submit forms or navigate on the user's behalf. */
const MUTATING_BROWSER_ACTIONS = new Set(['goto', 'click', 'type', 'press']);

/**
 * Tools a past approval must never auto-approve: each call is arbitrary code or
 * browser input, so approving one command says nothing about the next.
 */
const NEVER_AUTO_REVIEW = new Set([
  'computer_exec',
  'computer_write_file',
  'computer_run_code',
  'browser_act',
]);

export function toolRiskLevel(toolName: string, args?: unknown): 'low' | 'high' {
  if (toolName === 'browser_act') {
    const action = args && typeof args === 'object' ? (args as { action?: unknown }).action : undefined;
    return typeof action === 'string' && MUTATING_BROWSER_ACTIONS.has(action) ? 'high' : 'low';
  }
  return HIGH_RISK_TOOLS.has(toolName) ? 'high' : 'low';
}

/** Whether a prior approval of the same tool may auto-approve this call. */
export function allowsAutoReview(toolName: string): boolean {
  return !NEVER_AUTO_REVIEW.has(toolName);
}

function serializeApproval(row: typeof schema.weldagentApprovals.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    toolName: row.toolName,
    args: (row.args ?? {}) as Record<string, unknown>,
    riskLevel: row.riskLevel as 'low' | 'high',
    status: row.status as 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'expired',
    reason: row.reason,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createApproval(
  db: AgentDb,
  input: {
    agentId: string;
    conversationId?: string | null;
    toolName: string;
    args: Record<string, unknown>;
    riskLevel?: 'low' | 'high';
    createdBy?: string;
  },
) {
  const id = generateId('apr');
  await db.insert(schema.weldagentApprovals).values({
    id,
    agentId: input.agentId,
    conversationId: input.conversationId ?? null,
    toolName: input.toolName,
    args: input.args,
    riskLevel: input.riskLevel ?? toolRiskLevel(input.toolName),
    status: 'pending',
    createdBy: input.createdBy ?? null,
  });
  const [row] = await db
    .select()
    .from(schema.weldagentApprovals)
    .where(eq(schema.weldagentApprovals.id, id))
    .limit(1);
  return serializeApproval(row);
}

export async function listApprovals(db: AgentDb, opts?: { agentId?: string; status?: string }) {
  const conditions = [];
  if (opts?.agentId) conditions.push(eq(schema.weldagentApprovals.agentId, opts.agentId));
  if (opts?.status) conditions.push(eq(schema.weldagentApprovals.status, opts.status));
  const rows = await db
    .select()
    .from(schema.weldagentApprovals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.weldagentApprovals.createdAt))
    .limit(100);
  return rows.map(serializeApproval);
}

export async function decideApproval(
  db: AgentDb,
  id: string,
  input: { decision: 'approved' | 'rejected'; decidedBy: string; reason?: string },
) {
  const [row] = await db
    .select()
    .from(schema.weldagentApprovals)
    .where(eq(schema.weldagentApprovals.id, id))
    .limit(1);
  if (!row || row.status !== 'pending') return null;
  // Conditional on still-pending so a double click can't run the action twice.
  const claimed = await db
    .update(schema.weldagentApprovals)
    .set({
      status: input.decision,
      decidedBy: input.decidedBy,
      decidedAt: now(),
      reason: input.reason ?? null,
      updatedAt: now(),
    })
    .where(and(eq(schema.weldagentApprovals.id, id), eq(schema.weldagentApprovals.status, 'pending')))
    .returning({ id: schema.weldagentApprovals.id });
  if (claimed.length === 0) return null;
  const [updated] = await db
    .select()
    .from(schema.weldagentApprovals)
    .where(eq(schema.weldagentApprovals.id, id))
    .limit(1);
  return serializeApproval(updated);
}

export async function findPriorApproval(
  db: AgentDb,
  agentId: string,
  toolName: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.weldagentApprovals.id })
    .from(schema.weldagentApprovals)
    .where(
      and(
        eq(schema.weldagentApprovals.agentId, agentId),
        eq(schema.weldagentApprovals.toolName, toolName),
        eq(schema.weldagentApprovals.status, 'approved'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function serializeMemory(row: typeof schema.weldagentMemories.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind as 'preference' | 'fact' | 'summary' | 'correction',
    content: row.content,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMemories(db: AgentDb, agentId: string) {
  const rows = await db
    .select()
    .from(schema.weldagentMemories)
    .where(
      and(eq(schema.weldagentMemories.agentId, agentId), isNull(schema.weldagentMemories.deletedAt)),
    )
    .orderBy(desc(schema.weldagentMemories.updatedAt))
    .limit(100);
  return rows.map(serializeMemory);
}

export async function createMemory(
  db: AgentDb,
  input: {
    agentId: string;
    kind?: 'preference' | 'fact' | 'summary' | 'correction';
    content: string;
    source?: string;
    createdBy?: string;
  },
) {
  const id = generateId('mem');
  await db.insert(schema.weldagentMemories).values({
    id,
    agentId: input.agentId,
    kind: input.kind ?? 'fact',
    content: input.content.trim(),
    source: input.source ?? null,
    createdBy: input.createdBy ?? null,
  });
  const [row] = await db
    .select()
    .from(schema.weldagentMemories)
    .where(eq(schema.weldagentMemories.id, id))
    .limit(1);
  return serializeMemory(row);
}

export async function updateMemory(
  db: AgentDb,
  id: string,
  input: { content?: string; kind?: 'preference' | 'fact' | 'summary' | 'correction' },
) {
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (input.content !== undefined) patch.content = input.content.trim();
  if (input.kind !== undefined) patch.kind = input.kind;
  await db.update(schema.weldagentMemories).set(patch).where(eq(schema.weldagentMemories.id, id));
  const [row] = await db
    .select()
    .from(schema.weldagentMemories)
    .where(eq(schema.weldagentMemories.id, id))
    .limit(1);
  return row && !row.deletedAt ? serializeMemory(row) : null;
}

export async function deleteMemory(db: AgentDb, id: string) {
  await db
    .update(schema.weldagentMemories)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.weldagentMemories.id, id));
  return true;
}

export async function memoryPromptBlock(db: AgentDb, agentId: string): Promise<string> {
  const memories = await listMemories(db, agentId);
  if (memories.length === 0) return '';
  return (
    'Durable memory for this agent:\n' +
    memories
      .slice(0, 40)
      .map((m) => `- [${m.kind}] ${m.content}`)
      .join('\n')
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function serializeTemplate(row: typeof schema.weldagentTemplates.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    isPublic: row.isPublic,
    shareToken: row.shareToken,
    sourceAgentId: row.sourceAgentId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function exportAgentTemplate(
  db: AgentDb,
  input: {
    agentId: string;
    name?: string;
    description?: string;
    isPublic?: boolean;
    createdBy?: string;
  },
) {
  const agent = await getAgent(db, input.agentId);
  if (!agent) return null;
  const skills = await listAgentSkills(db, agent.id);
  const routines = await listRoutines(db, agent.id);
  const memories = await listMemories(db, agent.id);
  const id = generateId('tpl');
  const shareToken = generateId('share');
  const payload = {
    systemPrompt: agent.systemPrompt,
    permissions: agent.permissions,
    enabledTools: agent.enabledTools,
    modelId: agent.modelId,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      steps: s.steps,
    })),
    routines: routines.map((r) => ({
      name: r.name,
      instructions: r.instructions,
      scheduleKind: r.scheduleKind,
      cronExpr: r.cronExpr,
      timezone: r.timezone,
      eventKey: r.eventKey,
      connectorConfig: r.connectorConfig,
      requireApproval: r.requireApproval,
    })),
    memories: memories
      .filter((m) => m.kind === 'preference' || m.kind === 'fact')
      .map((m) => ({ kind: m.kind, content: m.content })),
  };
  await db.insert(schema.weldagentTemplates).values({
    id,
    name: (input.name ?? `${agent.name} template`).trim(),
    description: input.description ?? agent.description,
    payload,
    isPublic: input.isPublic ?? false,
    shareToken,
    sourceAgentId: agent.id,
    createdBy: input.createdBy ?? null,
  });
  const [row] = await db
    .select()
    .from(schema.weldagentTemplates)
    .where(eq(schema.weldagentTemplates.id, id))
    .limit(1);
  return serializeTemplate(row);
}

export async function getTemplateByShareToken(db: AgentDb, shareToken: string) {
  const [row] = await db
    .select()
    .from(schema.weldagentTemplates)
    .where(
      and(
        eq(schema.weldagentTemplates.shareToken, shareToken),
        isNull(schema.weldagentTemplates.deletedAt),
      ),
    )
    .limit(1);
  return row ? serializeTemplate(row) : null;
}

export async function getTemplate(db: AgentDb, id: string) {
  const [row] = await db
    .select()
    .from(schema.weldagentTemplates)
    .where(and(eq(schema.weldagentTemplates.id, id), isNull(schema.weldagentTemplates.deletedAt)))
    .limit(1);
  return row ? serializeTemplate(row) : null;
}

export async function installTemplate(
  db: AgentDb,
  input: {
    templateId?: string;
    shareToken?: string;
    name?: string;
    createdBy?: string;
  },
) {
  const template = input.templateId
    ? await getTemplate(db, input.templateId)
    : input.shareToken
      ? await getTemplateByShareToken(db, input.shareToken)
      : null;
  if (!template) return null;
  const payload = template.payload as {
    systemPrompt?: string;
    permissions?: string[];
    enabledTools?: string[];
    modelId?: string;
    skills?: Array<{ name: string; description?: string | null; instructions: string; steps?: Array<Record<string, unknown>> }>;
    routines?: Array<{
      name: string;
      instructions: string;
      scheduleKind?: 'cron' | 'event' | 'connector';
      cronExpr?: string | null;
      timezone?: string;
      eventKey?: string | null;
      connectorConfig?: typeof schema.weldagentRoutines.$inferInsert['connectorConfig'];
      requireApproval?: boolean;
    }>;
    memories?: Array<{ kind: 'preference' | 'fact' | 'summary' | 'correction'; content: string }>;
  };

  const agent = await createAgent(db, {
      name:
        input.name ??
        (template.name.replace(/\s*template$/i, '').trim() || 'Imported agent'),
      description: template.description,
    systemPrompt: payload.systemPrompt ?? '',
    permissions: payload.permissions ?? ['computer:use', 'browser:use'],
    enabledTools: payload.enabledTools ?? [],
    modelId: payload.modelId,
    createdBy: input.createdBy,
  });

  for (const skill of payload.skills ?? []) {
    const created = await createSkill(db, {
      ...skill,
      status: 'active',
      createdBy: input.createdBy,
      sourceAgentId: agent.id,
    });
    await enableSkillForAgent(db, agent.id, created.id);
  }
  for (const routine of payload.routines ?? []) {
    await createRoutine(db, {
      agentId: agent.id,
      ...routine,
      createdBy: input.createdBy,
    });
  }
  for (const mem of payload.memories ?? []) {
    await createMemory(db, {
      agentId: agent.id,
      kind: mem.kind,
      content: mem.content,
      source: 'template',
      createdBy: input.createdBy,
    });
  }

  if (payload.systemPrompt?.trim()) {
    await updateAgent(db, agent.id, { status: 'draft' });
  }

  return agent;
}

// ---------------------------------------------------------------------------
// Teach sessions
// ---------------------------------------------------------------------------

export async function startTeachSession(
  db: AgentDb,
  input: { agentId: string; title: string; createdBy?: string },
) {
  const id = generateId('tch');
  await db.insert(schema.weldagentTeachSessions).values({
    id,
    agentId: input.agentId,
    title: input.title.trim(),
    status: 'recording',
    steps: [],
    createdBy: input.createdBy ?? null,
  });
  return { id, agentId: input.agentId, title: input.title, status: 'recording' as const, steps: [] as Array<Record<string, unknown>> };
}

export async function appendTeachStep(db: AgentDb, id: string, step: Record<string, unknown>) {
  const [row] = await db
    .select()
    .from(schema.weldagentTeachSessions)
    .where(eq(schema.weldagentTeachSessions.id, id))
    .limit(1);
  if (!row || row.status !== 'recording') return null;
  const steps = [...((row.steps ?? []) as Array<Record<string, unknown>>), { ...step, at: now().toISOString() }];
  await db
    .update(schema.weldagentTeachSessions)
    .set({ steps })
    .where(eq(schema.weldagentTeachSessions.id, id));
  return { id, steps, status: row.status };
}

export async function stopTeachSession(
  db: AgentDb,
  id: string,
  input?: { createSkill?: boolean; skillName?: string; createdBy?: string },
) {
  const [row] = await db
    .select()
    .from(schema.weldagentTeachSessions)
    .where(eq(schema.weldagentTeachSessions.id, id))
    .limit(1);
  if (!row) return null;
  const steps = (row.steps ?? []) as Array<Record<string, unknown>>;
  let skillId: string | null = null;
  if (input?.createSkill !== false) {
    const skill = await createSkill(db, {
      name: input?.skillName ?? row.title,
      description: `Taught workflow with ${steps.length} steps`,
      instructions:
        `Perform this taught workflow carefully.\n` +
        steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join('\n') +
        `\nRequire approval before sending, deleting, purchasing, or publishing.`,
      steps,
      status: 'draft',
      createdBy: input?.createdBy,
      sourceAgentId: row.agentId,
    });
    skillId = skill.id;
    await enableSkillForAgent(db, row.agentId, skill.id);
  }
  await db
    .update(schema.weldagentTeachSessions)
    .set({ status: 'stopped', stoppedAt: now(), skillId })
    .where(eq(schema.weldagentTeachSessions.id, id));
  return { id, status: 'stopped' as const, skillId, steps };
}

