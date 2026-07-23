/**
 * Common-concepts service.
 *
 * Given the viewer's userId and a subject member's userId, returns things
 * that link them: shared chat channels (incl. DMs), common projects, shared
 * tasks, CRM opportunities/activities, and helpdesk conversations/tickets.
 *
 * Results are capped per category; UI can drill further if needed.
 *
 * Ported from apps/core-api/src/services/team/common-concepts.ts.
 */

import { and, eq, isNull, inArray, or, sql, desc } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import type {
  CommonChannel,
  CommonProject,
  CommonTask,
  CommonCrmRecord,
  CommonHelpdeskItem,
  CommonConceptCategory,
  CommonConceptsResponse,
} from '@weldsuite/app-api-client/schemas/team-members';

const PER_CATEGORY_LIMIT = 20;

export async function getCommonChannels(
  db: Database,
  viewerUserId: string,
  subjectUserId: string,
): Promise<CommonChannel[]> {
  const { chatChannels, chatChannelMembers } = schema;

  // channels where both users are members
  const rows = await db
    .select({
      id: chatChannels.id,
      name: chatChannels.name,
      type: chatChannels.type,
      memberCount: chatChannels.memberCount,
    })
    .from(chatChannels)
    .innerJoin(chatChannelMembers, eq(chatChannelMembers.channelId, chatChannels.id))
    .where(
      and(
        isNull(chatChannels.deletedAt),
        eq(chatChannels.isArchived, false),
        inArray(chatChannelMembers.userId, [viewerUserId, subjectUserId]),
      ),
    )
    .groupBy(chatChannels.id, chatChannels.name, chatChannels.type, chatChannels.memberCount)
    .having(sql`count(distinct ${chatChannelMembers.userId}) = 2`)
    .orderBy(desc(chatChannels.lastMessageAt))
    .limit(PER_CATEGORY_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type as 'public' | 'private' | 'dm',
    memberCount: r.memberCount ?? 0,
  }));
}

export async function getCommonProjects(
  db: Database,
  viewerUserId: string,
  subjectUserId: string,
): Promise<CommonProject[]> {
  const { projects, projectMembers } = schema;

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      color: projects.color,
    })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(
      and(
        isNull(projects.deletedAt),
        eq(projects.isActive, true),
        inArray(projectMembers.userId, [viewerUserId, subjectUserId]),
      ),
    )
    .groupBy(projects.id, projects.name, projects.status, projects.color)
    .having(sql`count(distinct ${projectMembers.userId}) = 2`)
    .orderBy(desc(projects.updatedAt))
    .limit(PER_CATEGORY_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    color: r.color,
  }));
}

export async function getCommonTasks(
  db: Database,
  viewerUserId: string,
  subjectUserId: string,
): Promise<CommonTask[]> {
  const { tasks } = schema;

  // A task is "common" if both users are assignees, or one is assignee while
  // the other is reporter/watcher, etc. Keeps the SQL simple — we look for
  // tasks where each user appears in at least one of the relevant fields.
  const userAppears = (userId: string) =>
    or(
      eq(tasks.assigneeId, userId),
      eq(tasks.reporterId, userId),
      sql`${tasks.assigneeIds} @> ${JSON.stringify([userId])}::jsonb`,
      sql`${tasks.watchers} @> ${JSON.stringify([userId])}::jsonb`,
    )!;

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      projectId: tasks.projectId,
      dueDate: tasks.dueDate,
      assigneeId: tasks.assigneeId,
      reporterId: tasks.reporterId,
    })
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        userAppears(viewerUserId),
        userAppears(subjectUserId),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(PER_CATEGORY_LIMIT);

  return rows.map((r) => {
    let role: CommonTask['role'] = 'shared_watcher';
    if (r.assigneeId === viewerUserId && r.reporterId === subjectUserId) role = 'delegated';
    else if (r.assigneeId === subjectUserId && r.reporterId === viewerUserId) role = 'delegated';
    else if (
      r.assigneeId === viewerUserId ||
      r.assigneeId === subjectUserId
    ) role = 'shared_assignee';

    return {
      id: r.id,
      title: r.title,
      status: r.status,
      projectId: r.projectId ?? null,
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      role,
    };
  });
}

export async function getCommonCrmRecords(
  db: Database,
  viewerUserId: string,
  subjectUserId: string,
): Promise<CommonCrmRecord[]> {
  const { crmOpportunities, crmActivities } = schema;

  const [opps, activities] = await Promise.all([
    db
      .select({
        id: crmOpportunities.id,
        name: crmOpportunities.name,
        status: crmOpportunities.status,
        updatedAt: crmOpportunities.updatedAt,
      })
      .from(crmOpportunities)
      .where(
        and(
          isNull(crmOpportunities.deletedAt),
          sql`${crmOpportunities.teamMembers} @> ${JSON.stringify([viewerUserId])}::jsonb`,
          sql`${crmOpportunities.teamMembers} @> ${JSON.stringify([subjectUserId])}::jsonb`,
        ),
      )
      .orderBy(desc(crmOpportunities.updatedAt))
      .limit(PER_CATEGORY_LIMIT),
    db
      .select({
        id: crmActivities.id,
        name: crmActivities.subject,
        status: crmActivities.status,
        updatedAt: crmActivities.updatedAt,
      })
      .from(crmActivities)
      .where(
        and(
          isNull(crmActivities.deletedAt),
          sql`${crmActivities.attendees} @> ${JSON.stringify([viewerUserId])}::jsonb`,
          sql`${crmActivities.attendees} @> ${JSON.stringify([subjectUserId])}::jsonb`,
        ),
      )
      .orderBy(desc(crmActivities.updatedAt))
      .limit(PER_CATEGORY_LIMIT),
  ]);

  const merged: CommonCrmRecord[] = [
    ...opps.map((o) => ({
      id: o.id,
      kind: 'opportunity' as const,
      name: o.name,
      status: o.status,
    })),
    ...activities.map((a) => ({
      id: a.id,
      kind: 'activity' as const,
      name: a.name,
      status: a.status,
    })),
  ];

  return merged.slice(0, PER_CATEGORY_LIMIT);
}

export async function getCommonHelpdesk(
  db: Database,
  viewerUserId: string,
  subjectUserId: string,
): Promise<CommonHelpdeskItem[]> {
  const { helpdeskConversations, helpdeskConversationEvents } = schema;

  // A conversation is shared if either user is currently assigned AND the
  // other has been assigned historically (recorded in conversation events).
  // For simplicity, we return conversations where either is currently assigned
  // and the other has any event on the conversation.
  const rows = await db
    .select({
      id: helpdeskConversations.id,
      subject: helpdeskConversations.subject,
      status: helpdeskConversations.status,
    })
    .from(helpdeskConversations)
    .where(
      and(
        isNull(helpdeskConversations.deletedAt),
        or(
          eq(helpdeskConversations.assigneeId, viewerUserId),
          eq(helpdeskConversations.assigneeId, subjectUserId),
        ),
        sql`EXISTS (
          SELECT 1 FROM ${helpdeskConversationEvents} e
          WHERE e.conversation_id = ${helpdeskConversations.id}
            AND e.actor_id IN (${viewerUserId}, ${subjectUserId})
          GROUP BY e.conversation_id
          HAVING count(distinct e.actor_id) = 2
        )`,
      ),
    )
    .orderBy(desc(helpdeskConversations.updatedAt))
    .limit(PER_CATEGORY_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    kind: 'conversation' as const,
    subject: r.subject,
    status: r.status,
  }));
}

export async function getCommonConcepts(
  db: Database,
  viewerUserId: string,
  subjectUserId: string,
  categories: CommonConceptCategory[],
): Promise<CommonConceptsResponse> {
  const want = new Set(categories);

  const [channels, projects, tasks, crm, helpdesk] = await Promise.all([
    want.has('channels') ? getCommonChannels(db, viewerUserId, subjectUserId) : Promise.resolve([]),
    want.has('projects') ? getCommonProjects(db, viewerUserId, subjectUserId) : Promise.resolve([]),
    want.has('tasks') ? getCommonTasks(db, viewerUserId, subjectUserId) : Promise.resolve([]),
    want.has('crm') ? getCommonCrmRecords(db, viewerUserId, subjectUserId) : Promise.resolve([]),
    want.has('helpdesk') ? getCommonHelpdesk(db, viewerUserId, subjectUserId) : Promise.resolve([]),
  ]);

  return { channels, projects, tasks, crm, helpdesk };
}
