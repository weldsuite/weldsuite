/**
 * Who can see, use and change a WeldAgent agent.
 *
 * An agent is treated like a teammate with a manager: its owner decides who
 * may work with it (`visibility`), can change it, and receives its approvals.
 * Workspace permissions still open the door (`weldagent:read` to see agents,
 * `weldagent:use` to chat, `weldagent:update` to edit); this module adds the
 * per-agent layer on top. Holders of `weldagent:manage` see and fix every
 * agent, the way an admin can fix any teammate's setup.
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { PermissionSubject } from '@weldsuite/permissions';
import { granterHolds } from './grants';

export const AGENT_VISIBILITIES = ['private', 'members', 'workspace'] as const;
export type AgentVisibility = (typeof AGENT_VISIBILITIES)[number];

export function isAgentVisibility(value: unknown): value is AgentVisibility {
  return typeof value === 'string' && (AGENT_VISIBILITIES as readonly string[]).includes(value);
}

/** The person looking at an agent, and whether they manage every agent. */
export interface AgentViewer {
  userId: string;
  /** Holds `weldagent:manage`. */
  canManageAll: boolean;
}

/** An unattended caller (event runs, routines, jobs): sees every agent. */
export const SYSTEM_VIEWER: AgentViewer = { userId: '', canManageAll: true };

/** The viewer for a person with these resolved permissions. */
export function agentViewerFor(userId: string, permissions: PermissionSubject | null | undefined): AgentViewer {
  return { userId, canManageAll: permissions ? granterHolds(permissions, 'weldagent:manage') : false };
}

/** Agent ids (of `agentIds`) the viewer may not use; checked when adding agents to a room. */
export async function inaccessibleAgentIds(db: Database, agentIds: string[], viewer: AgentViewer): Promise<string[]> {
  if (viewer.canManageAll || agentIds.length === 0) return [];
  const { weldagentAgents: a } = schema;
  const visible = agentVisibleTo(viewer);
  const rows = await db
    .select({ id: a.id })
    .from(a)
    .where(and(inArray(a.id, agentIds), isNull(a.deletedAt), visible));
  const ok = new Set(rows.map((row) => row.id));
  return agentIds.filter((id) => !ok.has(id));
}

interface AgentAccessFields {
  id: string;
  ownerId: string | null;
  visibility: string;
}

/**
 * SQL condition: agents the viewer can see. Ownerless agents (from before
 * ownership existed) are workspace-visible unless someone changed that.
 */
export function agentVisibleTo(viewer: AgentViewer): SQL | undefined {
  if (viewer.canManageAll) return undefined;
  const { weldagentAgents: a, weldagentAgentMembers: m } = schema;
  return or(
    eq(a.ownerId, viewer.userId),
    eq(a.visibility, 'workspace'),
    and(
      eq(a.visibility, 'members'),
      sql`exists (select 1 from ${m} where ${m.agentId} = ${a.id} and ${m.userId} = ${viewer.userId})`,
    ),
  );
}

/** Whether the viewer may see and chat with the agent. */
export async function canAccessAgent(
  db: Database,
  agent: AgentAccessFields,
  viewer: AgentViewer,
): Promise<boolean> {
  if (viewer.canManageAll || agent.visibility === 'workspace') return true;
  if (agent.ownerId && agent.ownerId === viewer.userId) return true;
  if (agent.visibility !== 'members') return false;
  const { weldagentAgentMembers: m } = schema;
  const [row] = await db
    .select({ id: m.id })
    .from(m)
    .where(and(eq(m.agentId, agent.id), eq(m.userId, viewer.userId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Whether the viewer may change the agent (instructions, grants, routines,
 * access). The owner or a manager; an ownerless legacy agent stays editable
 * by anyone with `weldagent:update`, as before ownership existed.
 */
export function canEditAgent(agent: Pick<AgentAccessFields, 'ownerId'>, viewer: AgentViewer): boolean {
  if (viewer.canManageAll) return true;
  if (!agent.ownerId) return true;
  return agent.ownerId === viewer.userId;
}

/** Members given access to the agent (visibility `members`). */
export async function listAgentMemberIds(db: Database, agentId: string): Promise<string[]> {
  const { weldagentAgentMembers: m } = schema;
  const rows = await db.select({ userId: m.userId }).from(m).where(eq(m.agentId, agentId));
  return rows.map((row) => row.userId);
}

/** Member lists for several agents at once (agent id → user ids). */
export async function listAgentMemberIdsFor(
  db: Database,
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (agentIds.length === 0) return result;
  const { weldagentAgentMembers: m } = schema;
  const rows = await db
    .select({ agentId: m.agentId, userId: m.userId })
    .from(m)
    .where(inArray(m.agentId, agentIds));
  for (const row of rows) {
    const list = result.get(row.agentId) ?? [];
    list.push(row.userId);
    result.set(row.agentId, list);
  }
  return result;
}

/** Replace the agent's member list. */
export async function setAgentMembers(
  db: Database,
  agentId: string,
  userIds: string[],
  createdBy: string | null,
): Promise<void> {
  const { weldagentAgentMembers: m } = schema;
  const wanted = [...new Set(userIds.filter(Boolean))];
  const current = await listAgentMemberIds(db, agentId);
  const toRemove = current.filter((id) => !wanted.includes(id));
  const toAdd = wanted.filter((id) => !current.includes(id));
  if (toRemove.length > 0) {
    await db.delete(m).where(and(eq(m.agentId, agentId), inArray(m.userId, toRemove)));
  }
  if (toAdd.length > 0) {
    await db
      .insert(m)
      .values(toAdd.map((userId) => ({ id: generateId('agm'), agentId, userId, createdBy })))
      .onConflictDoNothing();
  }
}

/** The agent (not deleted) when the viewer may access it, otherwise null. */
export async function findAccessibleAgentRow(db: Database, agentId: string, viewer: AgentViewer) {
  const { weldagentAgents: a } = schema;
  const [row] = await db
    .select()
    .from(a)
    .where(and(eq(a.id, agentId), isNull(a.deletedAt)))
    .limit(1);
  if (!row) return null;
  return (await canAccessAgent(db, row, viewer)) ? row : null;
}
