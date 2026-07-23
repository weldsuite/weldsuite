/**
 * WeldDesk department auto-assignment.
 *
 * Ported from api-worker `src/services/helpdesk/auto-assignment.ts` as part of
 * the legacy-worker phase-out. Backs `PATCH /api/conversations/:id/assign-team`
 * — transferring a conversation to a team drops the current assignee, then this
 * picks the next agent from that team's roster.
 *
 * NOT the same mechanism as `autoAssignOnAgentReply` in `conversation-messages.ts`:
 * that claims an unassigned conversation for whoever replied. This one is
 * department-driven (balanced or round-robin over a team's agents) and is what
 * the `autoAssignment` / `roundRobinAssignment` department flags configure.
 *
 * Pure function — no Hono context. Returns null when nothing was assigned
 * (auto-assignment off, or no eligible agent with capacity), which the caller
 * reports back as `autoAssigned: false`.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';

const { helpdeskDepartments, helpdeskAgents, helpdeskConversations } = schema;

export interface AutoAssignResult {
  assigneeId: string;
  assigneeName: string;
}

export async function autoAssignConversation(
  db: Database,
  departmentId: string,
  conversationId: string,
): Promise<AutoAssignResult | null> {
  // 1. The department opts in. No flag, no auto-assignment.
  const [department] = await db
    .select()
    .from(helpdeskDepartments)
    .where(and(eq(helpdeskDepartments.id, departmentId), isNull(helpdeskDepartments.deletedAt)))
    .limit(1);

  if (!department || !department.autoAssignment) return null;

  // 2. Eligible = active, not deleted, in this department (either via the
  //    `departmentId` column or the `teamIds` array), and under their ticket
  //    cap. Membership is filtered in JS because `teamIds` is a JSONB array;
  //    the roster is small (one workspace's agents).
  const allAgents = await db
    .select()
    .from(helpdeskAgents)
    .where(and(eq(helpdeskAgents.status, 'active'), isNull(helpdeskAgents.deletedAt)));

  const eligibleAgents = allAgents.filter((agent) => {
    const inDepartment =
      agent.departmentId === departmentId ||
      (Array.isArray(agent.teamIds) && agent.teamIds.includes(departmentId));
    const hasCapacity = (agent.currentActiveTickets ?? 0) < (agent.maxActiveTickets ?? 10);
    return inDepartment && hasCapacity;
  });

  if (eligibleAgents.length === 0) return null;

  let selectedAgent: (typeof eligibleAgents)[number];

  if (department.roundRobinAssignment) {
    // Round-robin: walk the alphabetical roster one step past whoever the
    // department's most recently touched conversation went to.
    const [lastAssigned] = await db
      .select({ assigneeId: helpdeskConversations.assigneeId })
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.departmentId, departmentId),
          isNull(helpdeskConversations.deletedAt),
          sql`${helpdeskConversations.assigneeId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(helpdeskConversations.updatedAt))
      .limit(1);

    const sorted = [...eligibleAgents].sort((a, b) => a.name.localeCompare(b.name));

    if (lastAssigned?.assigneeId) {
      const lastIndex = sorted.findIndex((a) => a.userId === lastAssigned.assigneeId);
      // findIndex === -1 (last assignee no longer eligible) wraps to sorted[0].
      selectedAgent = sorted[(lastIndex + 1) % sorted.length];
    } else {
      selectedAgent = sorted[0];
    }
  } else {
    // Balanced: whoever currently holds the fewest.
    selectedAgent = eligibleAgents.reduce((min, agent) =>
      (agent.currentActiveTickets ?? 0) < (min.currentActiveTickets ?? 0) ? agent : min,
    );
  }

  // 3. Hand the conversation over.
  await db
    .update(helpdeskConversations)
    .set({
      assigneeId: selectedAgent.userId,
      assigneeName: selectedAgent.name,
      updatedAt: new Date(),
    })
    .where(eq(helpdeskConversations.id, conversationId));

  // 4. Keep the agent's load counter in step so the next balanced pick is fair.
  await db
    .update(helpdeskAgents)
    .set({
      currentActiveTickets: sql`${helpdeskAgents.currentActiveTickets} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(helpdeskAgents.id, selectedAgent.id));

  return { assigneeId: selectedAgent.userId, assigneeName: selectedAgent.name };
}
