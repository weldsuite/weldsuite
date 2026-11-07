/**
 * Who may see and use a WeldAgent agent: the per-agent rule every module that
 * hands work to an agent applies (agent-api's chat and agent routes and its
 * event dispatch through `@weldsuite/agent-domain/access`, which re-exports
 * this; merge-api when an issue is assigned to an agent). Workspace permissions
 * open the door (`weldagent:use`); this decides which agents are behind it.
 *
 *   - holders of `weldagent:manage` reach every agent;
 *   - `workspace` agents are everyone's;
 *   - the owner reaches their own agent;
 *   - `members` agents are their owner's and their listed members'
 *     (`weldagent_agent_members`); `private` ones only their owner's.
 *
 * Ownerless agents (from before ownership existed) are workspace-visible unless
 * someone changed that. The Rust backend reads the same rule
 * (`weldsuite_chat_domain::agents`).
 */

import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

/** The person looking at an agent, and whether they manage every agent. */
export interface AgentViewer {
  userId: string;
  /** Holds `weldagent:manage`. */
  canManageAll: boolean;
}

/** An unattended caller (event runs, routines, jobs): sees every agent. */
export const SYSTEM_VIEWER: AgentViewer = { userId: '', canManageAll: true };

/** What the rule reads of an agent row. */
export interface AgentAccessFields {
  id: string;
  ownerId: string | null;
  visibility: string;
}

/** SQL condition: agents the viewer can see (undefined: every agent). */
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
export async function canAccessAgent(db: Database, agent: AgentAccessFields, viewer: AgentViewer): Promise<boolean> {
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
