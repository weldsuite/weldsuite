/**
 * WeldAgent agent CRUD + run persistence.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { recommended } from '@weldsuite/ai';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Variables } from '../../types';
import type { WeldagentAgentRunResult } from '@weldsuite/db/schema';

export type AgentDb = Variables['tenantDb'];

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
    createdBy: row.createdBy,
    totalRuns: row.totalRuns,
    successfulRuns: row.successfulRuns,
    failedRuns: row.failedRuns,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAgents(db: AgentDb, status?: string) {
  const { weldagentAgents: a } = schema;
  const conditions = [isNull(a.deletedAt)];
  if (status) conditions.push(eq(a.status, status));
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
  await db.insert(a).values({
    id,
    name: input.name,
    description: input.description ?? null,
    icon: input.icon ?? null,
    status: 'draft',
    systemPrompt: input.systemPrompt ?? '',
    modelId: input.modelId ?? recommended.copilot.free,
    temperature: input.temperature ?? '0.70',
    maxTokens: input.maxTokens ?? 2048,
    permissions: input.permissions ?? [],
    enabledTools: input.enabledTools ?? [],
    eventSubscriptions: input.eventSubscriptions ?? [],
    maxIterations: input.maxIterations ?? 10,
    maxTotalTokens: input.maxTotalTokens ?? 20000,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return (await getAgent(db, id))!;
}

export async function updateAgent(db: AgentDb, id: string, input: UpdateAgentInput) {
  const { weldagentAgents: a } = schema;
  const existing = await getAgent(db, id);
  if (!existing) return null;

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
  if (input.modelId !== undefined) patch.modelId = input.modelId;
  if (input.temperature !== undefined) patch.temperature = input.temperature;
  if (input.maxTokens !== undefined) patch.maxTokens = input.maxTokens;
  if (input.permissions !== undefined) patch.permissions = input.permissions;
  if (input.enabledTools !== undefined) patch.enabledTools = input.enabledTools;
  if (input.eventSubscriptions !== undefined) patch.eventSubscriptions = input.eventSubscriptions;
  if (input.maxIterations !== undefined) patch.maxIterations = input.maxIterations;
  if (input.maxTotalTokens !== undefined) patch.maxTotalTokens = input.maxTotalTokens;
  if (input.status !== undefined) patch.status = input.status;

  await db.update(a).set(patch).where(eq(a.id, id));
  return getAgent(db, id);
}

export async function deleteAgent(db: AgentDb, id: string) {
  const { weldagentAgents: a } = schema;
  const existing = await getAgent(db, id);
  if (!existing) return false;
  await db
    .update(a)
    .set({ deletedAt: new Date(), updatedAt: new Date(), status: 'paused' })
    .where(eq(a.id, id));
  return true;
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
