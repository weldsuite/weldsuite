/**
 * WeldAgent agent CRUD + run persistence.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DEFAULT_WORKSPACE_AGENT_MODEL } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { WeldagentAgentRunResult } from '@weldsuite/db/schema';
import { agentVisibleTo, SYSTEM_VIEWER, type AgentViewer, type AgentVisibility } from './access';

export type AgentDb = Database;

export interface CreateAgentInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  systemPrompt?: string;
  modelId?: string;
  temperature?: string;
  maxTokens?: number;
  permissions?: string[];
  enabledTools?: string[];
  eventSubscriptions?: string[];
  maxIterations?: number;
  maxTotalTokens?: number;
  createdBy?: string;
  visibility?: AgentVisibility;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  systemPrompt?: string;
  modelId?: string;
  temperature?: string;
  maxTokens?: number;
  permissions?: string[];
  enabledTools?: string[];
  eventSubscriptions?: string[];
  maxIterations?: number;
  maxTotalTokens?: number;
  status?: 'draft' | 'active' | 'paused';
  /** When true, stores `agent.auto_review` in enabledTools. */
  autoReviewEnabled?: boolean;
  ownerId?: string;
  visibility?: AgentVisibility;
  subagentIds?: string[];
  delegateToSelf?: boolean;
}

function serializeAgent(row: typeof schema.weldagentAgents.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    status: row.status as 'draft' | 'active' | 'paused',
    systemPrompt: row.systemPrompt,
    modelId: row.modelId,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    permissions: (row.permissions ?? []) as string[],
    enabledTools: (row.enabledTools ?? []) as string[],
    eventSubscriptions: (row.eventSubscriptions ?? []) as string[],
    maxIterations: row.maxIterations,
    maxTotalTokens: row.maxTotalTokens,
    /** Opt-in via enabledTools including `agent.auto_review` until column migration. */
    autoReviewEnabled: ((row.enabledTools ?? []) as string[]).includes('agent.auto_review'),
    createdBy: row.createdBy,
    ownerId: row.ownerId,
    visibility: row.visibility as AgentVisibility,
    subagentIds: (row.subagentIds ?? []) as string[],
    delegateToSelf: row.delegateToSelf,
    totalRuns: row.totalRuns,
    successfulRuns: row.successfulRuns,
    failedRuns: row.failedRuns,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Agents the viewer can see (every agent for {@link SYSTEM_VIEWER}, the
 * default, used by unattended callers such as event dispatch).
 */
export async function listAgents(db: AgentDb, status?: string, viewer: AgentViewer = SYSTEM_VIEWER) {
  const { weldagentAgents: a } = schema;
  const conditions = [isNull(a.deletedAt)];
  if (status) conditions.push(eq(a.status, status));
  const visible = agentVisibleTo(viewer);
  if (visible) conditions.push(visible);
  const rows = await db
    .select()
    .from(a)
    .where(and(...conditions))
    .orderBy(desc(a.updatedAt));
  return rows.map(serializeAgent);
}

export async function getAgent(db: AgentDb, id: string) {
  const { weldagentAgents: a } = schema;
  const [row] = await db
    .select()
    .from(a)
    .where(and(eq(a.id, id), isNull(a.deletedAt)))
    .limit(1);
  return row ? serializeAgent(row) : null;
}

export async function createAgent(db: AgentDb, input: CreateAgentInput) {
  const { weldagentAgents: a } = schema;
  const id = generateId('agt');
  const now = new Date();
  // Default cloud computer + browser like Grok Bot — still gated by Configure grants
  // the user can revoke. Explicit permissions in the create payload win.
  const permissions =
    input.permissions ??
    (['computer:use', 'browser:use'] as string[]);
  await db.insert(a).values({
    id,
    name: input.name,
    description: input.description ?? null,
    icon: input.icon ?? null,
    status: 'draft',
    systemPrompt: input.systemPrompt ?? '',
    modelId: input.modelId ?? DEFAULT_WORKSPACE_AGENT_MODEL,
    temperature: input.temperature ?? '0.70',
    maxTokens: input.maxTokens ?? 2048,
    permissions,
    enabledTools: input.enabledTools ?? [],
    eventSubscriptions: input.eventSubscriptions ?? [],
    maxIterations: input.maxIterations ?? 10,
    maxTotalTokens: input.maxTotalTokens ?? 20000,
    createdBy: input.createdBy ?? null,
    ownerId: input.createdBy ?? null,
    visibility: input.visibility ?? 'workspace',
    createdAt: now,
    updatedAt: now,
  });
  return (await getAgent(db, id))!;
}

/** Update fields that are copied to the row verbatim when present. */
const DIRECT_UPDATE_KEYS = [
  'name',
  'description',
  'icon',
  'systemPrompt',
  'modelId',
  'temperature',
  'maxTokens',
  'permissions',
  'enabledTools',
  'eventSubscriptions',
  'maxIterations',
  'maxTotalTokens',
  'ownerId',
  'visibility',
  'subagentIds',
  'delegateToSelf',
] as const satisfies readonly (keyof UpdateAgentInput)[];

function buildAgentPatch(
  input: UpdateAgentInput,
  existingEnabledTools: string[] | null | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of DIRECT_UPDATE_KEYS) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.autoReviewEnabled !== undefined) {
    const current = new Set(existingEnabledTools ?? []);
    if (input.autoReviewEnabled) current.add('agent.auto_review');
    else current.delete('agent.auto_review');
    patch.enabledTools = [...current];
  }
  if (input.status !== undefined) patch.status = input.status;
  return patch;
}

export async function updateAgent(db: AgentDb, id: string, input: UpdateAgentInput) {
  const { weldagentAgents: a } = schema;
  const existing = await getAgent(db, id);
  if (!existing) return null;

  const patch = buildAgentPatch(input, existing.enabledTools);

  await db.update(a).set(patch).where(eq(a.id, id));
  return getAgent(db, id);
}

/** Most agents one agent can delegate to (Managed Agents roster: 20 incl. self). */
export const MAX_SUBAGENTS = 19;

export type SubagentProblem =
  | { code: 'self' }
  | { code: 'too_many'; max: number }
  | { code: 'not_found'; agentId: string }
  | { code: 'duplicate_name'; agentName: string };

/**
 * Check a proposed sub-agent setup. Delegation is one level deep: working as
 * a sub-agent, an agent runs as its worker object, which never delegates (see
 * ./managed-agents). The coordinator picks roster members by name, so names
 * in the roster must be distinct (threads are matched by object id, see
 * ./executor findMember).
 */
export async function checkSubagents(
  db: AgentDb,
  agent: { id: string; name: string },
  subagentIds: string[],
): Promise<SubagentProblem | null> {
  const ids = [...new Set(subagentIds)];
  if (ids.includes(agent.id)) return { code: 'self' };
  if (ids.length > MAX_SUBAGENTS) return { code: 'too_many', max: MAX_SUBAGENTS };
  if (ids.length === 0) return null;

  const { weldagentAgents: a } = schema;
  const rows = await db
    .select({ id: a.id, name: a.name })
    .from(a)
    .where(and(inArray(a.id, ids), isNull(a.deletedAt)));
  const missing = ids.find((id) => !rows.some((row) => row.id === id));
  if (missing) return { code: 'not_found', agentId: missing };

  const seen = new Set([agent.name.trim().toLowerCase()]);
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (seen.has(key)) return { code: 'duplicate_name', agentName: row.name };
    seen.add(key);
  }
  return null;
}

/** The sub-agents an agent may delegate to (deleted ones dropped). */
export async function getSubagents(db: AgentDb, subagentIds: string[]) {
  if (subagentIds.length === 0) return [];
  const { weldagentAgents: a } = schema;
  const rows = await db
    .select()
    .from(a)
    .where(and(inArray(a.id, subagentIds), isNull(a.deletedAt)));
  return rows.map(serializeAgent);
}

export type SerializedAgent = ReturnType<typeof serializeAgent>;

/**
 * Soft-delete an agent. Returns false when it does not exist, otherwise its
 * Claude Managed Agents agent id (if it ever ran) so the caller can archive it.
 */
export async function deleteAgent(
  db: AgentDb,
  id: string,
): Promise<false | { anthropicAgentId: string | null }> {
  const { weldagentAgents: a } = schema;
  const [existing] = await db
    .select({ id: a.id, anthropicAgentId: a.anthropicAgentId })
    .from(a)
    .where(and(eq(a.id, id), isNull(a.deletedAt)))
    .limit(1);
  if (!existing) return false;
  await db
    .update(a)
    .set({ deletedAt: new Date(), updatedAt: new Date(), status: 'paused' })
    .where(eq(a.id, id));
  return { anthropicAgentId: existing.anthropicAgentId };
}

export async function listAgentRuns(db: AgentDb, agentId: string, limit = 50) {
  const { weldagentAgentRuns: r } = schema;
  const rows = await db
    .select()
    .from(r)
    .where(eq(r.agentId, agentId))
    .orderBy(desc(r.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    triggerType: row.triggerType,
    triggerData: row.triggerData,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    totalIterations: row.totalIterations,
    totalTokensUsed: row.totalTokensUsed,
    toolCallCount: row.toolCallCount,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createAgentRun(
  db: AgentDb,
  input: {
    agentId: string;
    status?: string;
    triggerType: string;
    triggerData?: Record<string, unknown>;
  },
) {
  const { weldagentAgentRuns: r } = schema;
  const id = generateId('run');
  const now = new Date();
  await db.insert(r).values({
    id,
    agentId: input.agentId,
    status: input.status ?? 'queued',
    triggerType: input.triggerType,
    triggerData: input.triggerData ?? null,
    createdAt: now,
  });
  return id;
}

export async function markRunRunning(db: AgentDb, runId: string) {
  const { weldagentAgentRuns: r } = schema;
  await db
    .update(r)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(r.id, runId));
}

export async function completeAgentRun(
  db: AgentDb,
  input: {
    runId: string;
    agentId: string;
    success: boolean;
    result?: WeldagentAgentRunResult;
    error?: string;
    totalIterations?: number;
    totalTokensUsed?: number;
    toolCallCount?: number;
  },
) {
  const { weldagentAgentRuns: r, weldagentAgents: a } = schema;
  const [run] = await db.select().from(r).where(eq(r.id, input.runId)).limit(1);
  const completedAt = new Date();
  const durationMs = run?.startedAt
    ? completedAt.getTime() - run.startedAt.getTime()
    : null;

  await db
    .update(r)
    .set({
      status: input.success ? 'completed' : 'failed',
      completedAt,
      durationMs,
      result: input.result ?? null,
      error: input.error ?? null,
      totalIterations: input.totalIterations ?? 0,
      totalTokensUsed: input.totalTokensUsed ?? 0,
      toolCallCount: input.toolCallCount ?? 0,
    })
    .where(eq(r.id, input.runId));

  await db
    .update(a)
    .set({
      totalRuns: sql`${a.totalRuns} + 1`,
      successfulRuns: input.success ? sql`${a.successfulRuns} + 1` : a.successfulRuns,
      failedRuns: input.success ? a.failedRuns : sql`${a.failedRuns} + 1`,
      lastRunAt: completedAt,
      lastRunStatus: input.success ? 'completed' : 'failed',
      updatedAt: completedAt,
    })
    .where(eq(a.id, input.agentId));
}

/**
 * Find active agents subscribed to a given event key (`person.created`, etc.).
 */
export async function findAgentsForEvent(db: AgentDb, eventKey: string) {
  const agents = await listAgents(db, 'active');
  return agents.filter((agent) => {
    const subs = agent.eventSubscriptions ?? [];
    return subs.includes(eventKey) || subs.includes('*');
  });
}
