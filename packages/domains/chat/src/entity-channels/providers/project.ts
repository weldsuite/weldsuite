import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { getProjectStats, EMPTY_PROJECT_STATS } from '@weldsuite/flow-domain/project-stats';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';

export const projectEntityProvider: EntityChannelProvider = {
  type: 'project',
  label: 'Projects',
  requiredPermission: 'projects:read',

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
        budgetedAmount: projects.budgetedAmount,
        actualAmount: projects.actualAmount,
        budgetCurrency: projects.budgetCurrency,
        billingMethod: projects.billingMethod,
        hourlyRate: projects.hourlyRate,
        isBillable: projects.isBillable,
        trackTime: projects.trackTime,
        color: projects.color,
        icon: projects.icon,
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

    // The stored counters are never maintained; derive them on read.
    const stats = await getProjectStats(db, [entityId]);

    return { ...project, ...(stats.get(entityId) ?? EMPTY_PROJECT_STATS), members };
  },

  /**
   * Live projects the caller manages or is an active member of, or every live
   * project with `projects:scope:all` (as flow-domain's `resolveProjectAccess`).
   */
  async filterVisible({ db, actingUserId, can }, entityIds) {
    if (entityIds.length === 0) return new Set();
    const { projects, projectMembers } = schema;

    const live = await db
      .select({ id: projects.id, projectManagerId: projects.projectManagerId })
      .from(projects)
      .where(and(inArray(projects.id, entityIds), isNull(projects.deletedAt)));
    if (await can('projects:scope:all')) return new Set(live.map((p) => p.id));

    const visible = new Set<string>();
    const others: string[] = [];
    for (const project of live) {
      if (project.projectManagerId === actingUserId) visible.add(project.id);
      else others.push(project.id);
    }

    if (others.length > 0) {
      const memberOf = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(
          and(
            inArray(projectMembers.projectId, others),
            eq(projectMembers.userId, actingUserId),
            eq(projectMembers.isActive, true),
            isNull(projectMembers.deletedAt),
          ),
        );
      for (const m of memberOf) visible.add(m.projectId);
    }
    return visible;
  },

  canAccess(ctx) {
    return canAccessViaFilter(projectEntityProvider, ctx);
  },
};

registerEntityProvider(projectEntityProvider);
