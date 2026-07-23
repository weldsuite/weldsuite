import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../../../db';
import { registerEntityProvider, type EntityChannelProvider } from '../registry';

export const projectEntityProvider: EntityChannelProvider = {
  type: 'project',
  label: 'Projects',
  requiredPermission: 'messages:read',

  async resolve({ db, entityId }) {
    const { projects, projectMembers } = schema;

    const [project] = await db
      .select({ name: projects.name, projectManagerId: projects.projectManagerId })
      .from(projects)
      .where(and(eq(projects.id, entityId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) return null;

    const members = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, entityId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      );

    const memberIds = new Set<string>();
    for (const m of members) memberIds.add(m.userId);
    if (project.projectManagerId) memberIds.add(project.projectManagerId);

    return {
      displayName: project.name,
      defaultMemberIds: Array.from(memberIds),
    };
  },

  async resolveDetail({ db, entityId }) {
    const { projects, projectMembers } = schema;
    const [project] = await db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        priority: projects.priority,
        health: projects.health,
        progress: projects.progress,
        type: projects.type,
        methodology: projects.methodology,
        visibility: projects.visibility,
        projectManagerId: projects.projectManagerId,
        leaderId: projects.leaderId,
        customerId: projects.customerId,
        startDate: projects.startDate,
        endDate: projects.endDate,
        actualStartDate: projects.actualStartDate,
        actualEndDate: projects.actualEndDate,
        budgetedHours: projects.budgetedHours,
        actualHours: projects.actualHours,
        budgetedAmount: projects.budgetedAmount,
        actualAmount: projects.actualAmount,
        budgetCurrency: projects.budgetCurrency,
        billingMethod: projects.billingMethod,
        hourlyRate: projects.hourlyRate,
        isBillable: projects.isBillable,
        trackTime: projects.trackTime,
        color: projects.color,
        icon: projects.icon,
        totalTasks: projects.totalTasks,
        completedTasks: projects.completedTasks,
        openTasks: projects.openTasks,
        totalMilestones: projects.totalMilestones,
        completedMilestones: projects.completedMilestones,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(and(eq(projects.id, entityId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) return null;

    const members = await db
      .select({ userId: projectMembers.userId, role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, entityId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      );

    return { ...project, members };
  },

  async canAccess({ db, actingUserId, entityId }) {
    const { projects, projectMembers } = schema;

    const [project] = await db
      .select({ projectManagerId: projects.projectManagerId })
      .from(projects)
      .where(and(eq(projects.id, entityId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) return false;
    if (project.projectManagerId === actingUserId) return true;

    const [member] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, entityId),
          eq(projectMembers.userId, actingUserId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      )
      .limit(1);

    return !!member;
  },
};

registerEntityProvider(projectEntityProvider);
